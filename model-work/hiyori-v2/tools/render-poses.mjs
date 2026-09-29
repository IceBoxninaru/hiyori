// Headless review renders for the Hiyori v2 prototype (Canvas2D on
// @napi-rs/canvas). Output: out/review/*.png + out/review/report.json.
//   node tools/render-poses.mjs [joints|fingers|gestures|overhead|all]
// These images are inputs for human/Codex visual review, not a pass verdict.
import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {workRoot} from '../src/cubism-core-node.mjs';
import {createWorkbench} from './workbench-node.mjs';
import {GestureController} from '../src/controller.mjs';
import {GESTURES} from '../src/gestures.mjs';

const OUT = path.join(workRoot, 'out', 'review');
const LIGHT = '#ffffff', DARK = '#1e1f26';
const FINGER_CHANNELS = {thumb: 'FingerThumb', index: 'FingerIndex', middle: 'FingerMiddle', ring: 'FingerRing', pinky: 'FingerPinky'};

async function save(canvas, name) {
  await writeFile(path.join(OUT, name), canvas.toBuffer('image/png'));
  console.log('wrote', path.join('out', 'review', name));
}

function label(ctx, text, x, y, color = '#c0144a') {
  ctx.font = '14px sans-serif'; ctx.fillStyle = color; ctx.fillText(text, x, y);
}

// Highest y of the head: top of the front/back hair meshes at rest.
function headTop(wb) {
  const drawables = wb.model.update();
  let top = -Infinity;
  for (const d of drawables) if (d.part === 'PartHairFront' || d.part === 'PartHairBack' || d.part === 'PartFace') for (let i = 1; i < d.positions.length; i += 2) top = Math.max(top, d.positions[i]);
  return top;
}

async function joints(wb, report) {
  for (const side of ['L', 'R']) {
    for (const [bgName, bg] of [['light', LIGHT], ['dark', DARK]]) {
      const cw = 260, ch = 330, shoulders = [0, 45, 90, 135], elbows = [0, 60, 120], wrists = [-45, 0, 45];
      const sheet = wb.createCanvas(cw * elbows.length * wrists.length, ch * shoulders.length + 10);
      const g = sheet.getContext('2d');
      g.fillStyle = bg; g.fillRect(0, 0, sheet.width, sheet.height);
      const fx = side === 'L' ? 0.2 : -0.2;
      shoulders.forEach((s, row) => elbows.forEach((e, ei) => wrists.forEach((w, wi) => {
        const channels = {[`ArmShoulder${side}`]: s, [`ArmElbow${side}`]: e, [`ArmWrist${side}`]: w};
        const {canvas} = wb.render({channels}, {width: cw, height: ch, zoom: 1.7, focus: [fx, 0.25], background: bg});
        const col = ei * wrists.length + wi;
        g.drawImage(canvas, col * cw, row * ch);
        label(g, `S${s} E${e} W${w}`, col * cw + 6, row * ch + 16, bg === DARK ? '#ffd166' : '#c0144a');
      })));
      await save(sheet, `joints-${side}-${bgName}.png`);
    }
  }
  report.joints = 'rendered 36 combinations per side on light and dark backgrounds';
}

async function overhead(wb, report) {
  const top = headTop(wb);
  const channels = {ArmShoulderL: 162, ArmElbowL: -22, ArmWristL: -12, HandCurlL: -0.6, FingerSpreadL: 0.8};
  wb.rig.reset(); for (const [k, v] of Object.entries(channels)) wb.rig.set(k, v);
  const lm = wb.rig.landmarks('L');
  wb.rig.reset();
  report.overhead = {channels, headTopY: +top.toFixed(4), wristY: +lm.wrist[1].toFixed(4), wristAboveHeadTop: lm.wrist[1] > top};
  for (const [bgName, bg] of [['light', LIGHT], ['dark', DARK]]) {
    const {canvas} = wb.render({channels}, {width: 900, height: 1260, background: bg, debug: true});
    const g = canvas.getContext('2d');
    const view = {scale: Math.min(900 / (2976 / 2976), 1260 / (4175 / 2976))};
    g.strokeStyle = '#18a558'; g.setLineDash([6, 6]);
    const y = 1260 / 2 - top * view.scale;
    g.beginPath(); g.moveTo(0, y); g.lineTo(900, y); g.stroke(); g.setLineDash([]);
    label(g, `head top y=${top.toFixed(3)}  wrist y=${lm.wrist[1].toFixed(3)}`, 10, y - 6, '#18a558');
    await save(canvas, `overhead-${bgName}.png`);
  }
}

async function fingers(wb, report) {
  report.fingers = {};
  for (const side of ['L', 'R']) {
    const wrist = wb.manifest.arms[side].pivots.wrist;
    const values = [0, 0.5, 1, 0, -1];
    const cw = 230, ch = 230;
    const names = Object.keys(FINGER_CHANNELS);
    const sheet = wb.createCanvas(cw * values.length, ch * names.length);
    const g = sheet.getContext('2d');
    g.fillStyle = LIGHT; g.fillRect(0, 0, sheet.width, sheet.height);
    // Movement isolation: count moved vertices per rig item.
    wb.rig.reset();
    const restItems = new Map(wb.rig.solve().map(i => [i.id, i.positions]));
    for (const [row, finger] of names.entries()) {
      for (const [col, v] of values.entries()) {
        const channels = {[FINGER_CHANNELS[finger] + side]: v};
        const {canvas} = wb.render({channels}, {width: cw, height: ch, zoom: 11, focus: [wrist[0], wrist[1] - 0.012]});
        g.drawImage(canvas, col * cw, row * ch);
        label(g, `${side}.${finger} ${v}`, col * cw + 6, row * ch + 16);
      }
      wb.rig.reset(); wb.rig.set(FINGER_CHANNELS[finger] + side, 1);
      const moved = wb.rig.solve().filter(i => {
        const r = restItems.get(i.id);
        return i.positions.some((p, k) => Math.abs(p - r[k]) > 1e-6);
      }).map(i => i.id);
      report.fingers[`${side}.${finger}`] = moved;
      wb.rig.reset();
    }
    await save(sheet, `fingers-${side}.png`);
    // Continuous open -> point -> fist sequence (one hand, 10 frames).
    const seq = [];
    for (let i = 0; i <= 9; i++) {
      const t = i / 9;
      const open = Math.min(1, t / 0.33), fist = Math.max(0, (t - 0.55) / 0.45);
      const c = {};
      for (const f of ['middle', 'ring', 'pinky', 'thumb']) c[FINGER_CHANNELS[f] + side] = -1 + 2 * Math.min(1, open) * (t > 0.33 ? 1 : 0) * 1 + 0;
      // open (-1) until 0.33, others curl to 1 by 0.55 (point), index curls last
      for (const f of ['middle', 'ring', 'pinky', 'thumb']) c[FINGER_CHANNELS[f] + side] = t < 0.33 ? -1 : Math.min(1, -1 + 2 * (t - 0.33) / 0.22);
      c[FINGER_CHANNELS.index + side] = t < 0.55 ? -1 : -1 + 2 * fist;
      seq.push(c);
    }
    const strip = wb.createCanvas(cw * seq.length, ch);
    const sg = strip.getContext('2d'); sg.fillStyle = LIGHT; sg.fillRect(0, 0, strip.width, ch);
    for (const [i, channels] of seq.entries()) {
      const {canvas} = wb.render({channels}, {width: cw, height: ch, zoom: 11, focus: [wrist[0], wrist[1] - 0.012]});
      sg.drawImage(canvas, i * cw, 0);
      label(sg, i === 0 ? 'open' : i === 4 ? 'point' : i === 9 ? 'fist' : `${i}`, i * cw + 6, 16);
    }
    await save(strip, `open-point-fist-${side}.png`);
  }
}

async function gestures(wb, report) {
  report.gestures = {};
  const coreDefaults = new Map(wb.model.parameterIds.map((id, i) => [id, wb.model.parameterDefault[i]]));
  for (const id of Object.keys(GESTURES)) {
    const controller = new GestureController(wb.rig, coreDefaults);
    controller.setMouthOpen(0.2);
    const duration = GESTURES[id].duration;
    const samples = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95, 1.05].map(f => f * duration);
    const cw = 300, ch = 420;
    const sheet = wb.createCanvas(cw * samples.length, ch);
    const g = sheet.getContext('2d'); g.fillStyle = LIGHT; g.fillRect(0, 0, sheet.width, ch);
    wb.rig.reset();
    controller.play(id, 0);
    let mouthKept = true;
    for (const [i, t] of samples.entries()) {
      const core = controller.update(t);
      if (core.get('ParamMouthOpenY') !== 0.2) mouthKept = false;
      const channels = Object.fromEntries(wb.rig.channelNames().map(n => [n, wb.rig.get(n)]));
      const {canvas} = wb.render({channels, coreParams: Object.fromEntries(core)}, {width: cw, height: ch, zoom: 1.35, focus: [0, 0.22]});
      g.drawImage(canvas, i * cw, 0);
      label(g, `${id} t=${t.toFixed(2)}s`, i * cw + 6, 16);
    }
    report.gestures[id] = {duration, endsAtRest: wb.rig.isAtRest() && controller.core.size === 0, mouthKeptAt0_2: mouthKept};
    wb.rig.reset();
    await save(sheet, `gesture-${id}.png`);
  }
}

const mode = process.argv[2] || 'all';
await mkdir(OUT, {recursive: true});
const wb = await createWorkbench({rebuild: true});
const report = {generatedAt: new Date().toISOString(), note: 'Numeric facts only; visual acceptance is a separate human/Codex review.'};
if (mode === 'all' || mode === 'overhead') await overhead(wb, report);
if (mode === 'all' || mode === 'fingers') await fingers(wb, report);
if (mode === 'all' || mode === 'gestures') await gestures(wb, report);
if (mode === 'all' || mode === 'joints') await joints(wb, report);
await writeFile(path.join(OUT, `report-${mode}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
