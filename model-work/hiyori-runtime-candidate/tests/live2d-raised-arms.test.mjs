import test from 'node:test';
import assert from 'node:assert/strict';
import {Live2DAvatar} from '../public/live2d-avatar.mjs';
import {motionPresets,motionArmPoseByModel} from '../public/motion-presets.mjs';

const normalized=id=>id.replace(/_/g,'').toLowerCase();
const raisedPresets=motionPresets.filter(preset=>motionArmPoseByModel.hiyori[preset.id]==='raised');
const normalPreset=motionPresets.find(preset=>motionArmPoseByModel.hiyori[preset.id]==='normal');
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
function frame(extra={}){return {state:'speaking',expression:'happy',gesture:'none',head:'still',gaze:'forward',intensity:1,
  epoch:1,inputSeq:1,turnId:'reply-1',expiresAt:10000,...extra};}

function fixture(t,{characterId='hiyori',partsAvailable=true,motionResult=true}={}){
  const specs=[['ParamArmLA',-10,10,0],['ParamArmRA',-10,10,0],['ParamArmLB',-10,10,0],['ParamArmRB',-10,10,0],
    ['ParamHandLB',-10,10,10],['ParamHandRB',-10,10,10],['ParamHandL',-1,1,0],['ParamHandR',-1,1,0],
    ['ParamAngleX',-30,30,0],['ParamAngleY',-30,30,0],['ParamAngleZ',-30,30,0],
    ['ParamEyeLOpen',0,1.2,1],['ParamEyeROpen',0,1.2,1],['ParamEyeBallX',-1,1,0],['ParamEyeBallY',-1,1,0],
    ['ParamMouthOpenY',0,1,0],['ParamMouthForm',-2,1,1],
    ['ParamBrowLY',-1,1,0],['ParamBrowRY',-1,1,0],['ParamBrowLAngle',-1,1,0],['ParamBrowRAngle',-1,1,0]];
  const parameters=specs.map(([id,min,max,value],index)=>({id,index,min,max,default:value}));
  const values=new Map(parameters.map(p=>[p.id,p.default])),saved=new Map(values),selectors=new Map([['PartArmA',1],['PartArmB',0]]);
  const parts={ids:['UnrelatedPart','PartArmB','PartArmA'],opacities:new Float32Array([.625,0,1])};
  const partWrites=[],motions=[];
  const core={getModel:()=>({parts:partsAvailable?parts:undefined}),
    setParameterValueById(id,value){
      assert.ok(Number.isFinite(value));
      if(selectors.has(id)){assert.ok(partsAvailable);partWrites.push({id,value});selectors.set(id,value);}
      else{assert.ok(values.has(id),`unexpected parameter ${id}`);values.set(id,value);}
    },
    getParameterValueById:id=>selectors.has(id)?selectors.get(id):values.get(id),
    // Like Cubism, saved parameter arrays exclude synthetic pose selectors.
    saveParameters(){for(const [id,value]of values)saved.set(id,value);},
    loadParameters(){for(const [id,value]of saved)values.set(id,value);}};
  const manager={groups:{idle:'Idle'},definitions:{App:Array.from({length:motionPresets.length},()=>({}))},stopAllMotions(){}};
  const avatar=new Live2DAvatar({canvas:{},now:()=>0});
  avatar.character={id:characterId,name:'Test character'};
  avatar.parameters=new Map(parameters.map(p=>[normalized(p.id),p]));
  avatar.lipIds=['ParamMouthOpenY'];avatar.eyeIds=['ParamEyeLOpen','ParamEyeROpen'];
  function sdkPose(){
    if(!partsAvailable)return;
    const useA=selectors.get('PartArmA')>.001;
    parts.opacities[2]=useA?1:0;parts.opacities[1]=useA?0:1;
  }
  const model={internalModel:{coreModel:core,motionManager:manager,focusController:{focus(){}}},
    motion(group,index,priority){motions.push({group,index,priority});return typeof motionResult==='function'?motionResult(motions.length):motionResult;},
    update(){core.loadParameters();sdkPose();avatar.applyFace();core.loadParameters();},destroy(){this.destroyed=true;}};
  avatar.model=model;avatar.app={stage:{removeChild(){}},renderer:{render(){},clear(){}},destroy(){}};
  const globals=new Map(['requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.defineProperty(globalThis,'requestAnimationFrame',{value:()=>1,configurable:true});
  Object.defineProperty(globalThis,'cancelAnimationFrame',{value:()=>{},configurable:true});
  t.after(async()=>{await avatar.destroy();for(const [key,descriptor]of globals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return {avatar,model,core,parts,selectors,partWrites,motions,
    draw(pose={}){core.loadParameters();for(const [id,value]of Object.entries(pose))core.setParameterValueById(id,value);core.saveParameters();sdkPose();avatar.applyFace();
      const rendered=new Map(values);core.loadParameters();return rendered;},
    setLegacyRaised(){selectors.set('PartArmA',0);selectors.set('PartArmB',1);parts.opacities[2]=0;parts.opacities[1]=1;}};
}
function assertNormal(f){
  assert.equal(f.selectors.get('PartArmA'),1);assert.equal(f.selectors.get('PartArmB'),0);
  assert.equal(f.parts.opacities[2],1);assert.equal(f.parts.opacities[1],0);assert.equal(f.parts.opacities[0],.625);
}
function assertRaised(f){
  assert.equal(f.selectors.get('PartArmA'),0);assert.equal(f.selectors.get('PartArmB'),1);
  assert.equal(f.parts.opacities[2],0);assert.equal(f.parts.opacities[1],1);assert.equal(f.parts.opacities[0],.625);
}

test('each authored raised performance selects only the verified arm drawing and fades after SDK pose',async t=>{
  assert.ok(raisedPresets.length>0,'the accepted pack must include at least one raised gesture');
  for(const preset of raisedPresets)await t.test(preset.id,async child=>{
    const f=fixture(child);f.avatar.applyPerformance(frame({gesture:preset.id}));await flush();
    assert.equal(f.avatar.armPose.mode,'raised');assertNormal(f);
    f.avatar.elapsed=.09;f.draw();
    assert.equal(f.selectors.get('PartArmA'),0);assert.equal(f.selectors.get('PartArmB'),1,'selectors are exclusive even midway through an opacity blend');
    assert.ok(Math.abs(f.parts.opacities[1]-.5)<1e-6);assert.ok(Math.abs(f.parts.opacities[2]-.5)<1e-6);
    f.avatar.elapsed=.2;f.draw();assertRaised(f);
    assert.equal(f.parts.opacities[0],.625,'unrelated part opacity remains untouched');
  });
});

test('B wrist strength blends from its actual default 10 while live mouth remains independent',async t=>{
  const preset=raisedPresets[0];const f=fixture(t);
  f.avatar.applyPerformance(frame({gesture:preset.id,intensity:.5}));await flush();f.avatar.elapsed=.3;f.avatar.mouth=.72;
  const rendered=f.draw({ParamArmLB:8,ParamHandLB:0,ParamHandRB:-4,ParamMouthOpenY:.95});
  assert.equal(rendered.get('ParamArmLB'),4);assert.equal(rendered.get('ParamHandLB'),5);assert.equal(rendered.get('ParamHandRB'),3);
  assert.equal(rendered.get('ParamMouthOpenY'),.72);assertRaised(f);
});

test('preview uses the same raised drawing and returns before completion, clearing unsaved pose selectors',async t=>{
  const preset=raisedPresets[0],f=fixture(t);assert.equal(await f.avatar.playMotion(preset),true);
  f.avatar.elapsed=.3;f.draw();assertRaised(f);
  f.avatar.elapsed=preset.duration-.09;f.draw();assert.ok(Math.abs(f.parts.opacities[1]-.5)<1e-5);
  f.avatar.elapsed=preset.duration;f.draw();assertNormal(f);
  f.avatar.elapsed=preset.duration+.25;f.avatar.tick(16);
  assert.equal(f.avatar.preview,false);assert.equal(f.avatar.armPose,null);assertNormal(f);
  f.core.loadParameters();assertNormal(f);
});

test('all interruption and lifecycle paths synchronously restore the A selectors and visible drawing',async t=>{
  const stops=[
    ['preview cancel','preview',f=>f.avatar.stopPreview('interrupted')],
    ['listening','performance',f=>f.avatar.applyPerformance(frame({state:'listening',expression:'calm',gesture:'none',inputSeq:2}))],
    ['disconnected','performance',f=>f.avatar.applyPerformance(frame({state:'disconnected',expression:'calm',gesture:'none',inputSeq:2,expiresAt:null}))],
    ['reduced','performance',f=>f.avatar.setReducedMotion(true)],
    ['inactive','performance',f=>f.avatar.setActive(false)],
    ['model change','performance',f=>f.avatar.select(null)],
    ['destroy','preview',f=>f.avatar.destroy()],
  ];
  for(const [name,mode,stop]of stops)await t.test(name,async child=>{
    const f=fixture(child),preset=raisedPresets[0];
    if(mode==='preview')await f.avatar.playMotion(preset);else{f.avatar.applyPerformance(frame({gesture:preset.id}));await flush();}
    f.avatar.elapsed=.3;f.draw();assertRaised(f);
    await stop(f);assert.equal(f.avatar.armPose,null);assertNormal(f);
    f.core.loadParameters();assertNormal(f,'restoring real parameters cannot revive synthetic selectors');
    if(f.avatar.model){f.avatar.setReducedMotion(false);f.avatar.setActive(true);f.avatar.elapsed+=1;f.draw();assertNormal(f);}
  });
});

test('a stopped or superseded async preview cannot restore the raised drawing',async t=>{
  for(const replacement of ['cancel','normal'])await t.test(replacement,async child=>{
    const pending=deferred(),f=fixture(child,{motionResult:call=>call===1?pending.promise:true});
    const opening=f.avatar.playMotion(raisedPresets[0]);
    if(replacement==='cancel')f.avatar.stopPreview('interrupted');else assert.equal(await f.avatar.playMotion(normalPreset),true);
    pending.resolve(true);assert.equal(await opening,false);
    f.avatar.elapsed=.5;f.draw();assertNormal(f);
    assert.equal(f.avatar.armPose?.mode??null,replacement==='normal'?'normal':null);
  });
});

test('a late performance start cannot reenable B after listening or a normal replacement',async t=>{
  for(const state of ['listening','speaking'])await t.test(state,async child=>{
    const pending=deferred(),f=fixture(child,{motionResult:call=>call===1?pending.promise:true});
    f.avatar.applyPerformance(frame({gesture:raisedPresets[0].id}));
    f.avatar.applyPerformance(frame({state,gesture:state==='speaking'?normalPreset.id:'none',inputSeq:2,turnId:'new'}));
    pending.resolve(true);await flush();f.avatar.elapsed=.5;f.draw();assertNormal(f);
    assert.equal(f.avatar.armPose?.mode??null,state==='speaking'?'normal':null);
  });
});

test('normal motion immediately hides an old raised preview before its own async load completes',async t=>{
  const pending=deferred(),f=fixture(t,{motionResult:call=>call===1?true:pending.promise});
  await f.avatar.playMotion(raisedPresets[0]);f.avatar.elapsed=.3;f.draw();assertRaised(f);
  const opening=f.avatar.playMotion(normalPreset);assertNormal(f);
  pending.resolve(true);await opening;f.avatar.elapsed+=.3;f.draw();assertNormal(f);
});

test('performance neutral clears legacy pose leakage but the ordinary legacy renderer keeps SDK pose ownership',t=>{
  const f=fixture(t);f.setLegacyRaised();f.draw();assertRaised(f);assert.equal(f.partWrites.length,0);
  f.avatar.applyPerformance(frame({armPose:'raised',parts:{PartArmB:1}}));assertNormal(f);
  f.setLegacyRaised();f.draw();assertNormal(f,'extra provider fields cannot request the raised drawing');
});

test('entering performance clears saved legacy values even when a sparse new motion does not own those channels',async t=>{
  const f=fixture(t);
  f.core.setParameterValueById('ParamAngleX',30);f.core.setParameterValueById('ParamArmRA',9);f.core.setParameterValueById('ParamHandLB',-10);f.core.saveParameters();
  f.setLegacyRaised();f.avatar.mouth=.65;
  f.avatar.applyPerformance(frame());await flush();
  const rendered=f.draw();
  assert.equal(rendered.get('ParamAngleX'),0);assert.equal(rendered.get('ParamArmRA'),0);assert.equal(rendered.get('ParamHandLB'),10);
  assert.equal(rendered.get('ParamMouthOpenY'),.65);assertNormal(f);
});

test('unknown, Chitose, missing ID and incomplete rigs never receive synthetic arm writes',async t=>{
  for(const [name,options]of [['unknown',{characterId:'custom'}],['Chitose',{characterId:'chitose'}],
    ['missing ID',{characterId:null}],['missing parts',{partsAvailable:false}]])await t.test(name,async child=>{
    const f=fixture(child,options);f.setLegacyRaised();
    f.avatar.applyPerformance(frame({gesture:raisedPresets[0].id}));await flush();f.avatar.elapsed=.3;f.draw();
    assert.equal(f.avatar.armPose,null);assert.equal(f.partWrites.length,0);assertRaised(f);
    f.avatar.setReducedMotion(true);f.avatar.setActive(false);assert.equal(f.partWrites.length,0);
  });
});
