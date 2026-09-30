# G2: right-arm raise in native Cubism Editor (authoring handoff)

**Status: procedure only.** Nothing here has been done in the Editor. No parameter, deformer or ID named
below exists until a native export proves it. Record results in
`g2-right-arm-checkpoints.template.json` (a draft template, not evidence). The local coordinator performs all
GUI editing, saving, export and WebGL validation.

Goal: the character's right arm rises smoothly from hanging, through shoulder level and beside the head, to
overhead, and returns. The shoulder and sleeve must stay clean, and the old parameter behaviour must be
preserved. Do not narrow the target range to hide defects. If repair turns out worse than reconstruction,
switch to a redrawn shoulder-to-hand assembly (section 8).

## 0. Sources and label confidence

The official manual cannot be opened from the cloud environment. The pages below were located through a
search index, and the quoted labels come from those excerpts. Confirm every label in Editor 5.3.04 before
following a step. Where the Editor differs, the Editor wins; note the difference in the template.

| Topic | Official page | Label/behaviour used here |
| --- | --- | --- |
| Rotation deformers | [Rotation Deformer](https://docs.live2d.com/en/cubism-editor-manual/making-and-rotation-of-rotationdeformer/) | Ctrl+drag adjusts the deformer's position/angle **without moving its children**; Alt+drag changes handle length |
| Deformer basics / parenting | [About Deformers](https://docs.live2d.com/en/cubism-editor-manual/deformer/), [Warp Deformer](https://docs.live2d.com/en/cubism-editor-manual/making-and-placement-of-warp-deformer/) | Ctrl held while moving a deformer; otherwise the contents move with it |
| Parameters | [About Parameters](https://docs.live2d.com/en/cubism-editor-manual/parameter/), [Parameter palette](https://docs.live2d.com/en/cubism-editor-manual/palametorpalatte/) | "Create New Parameter" dialog; its Blend Shape checkbox stays **off** here |
| Keys | [Add/Delete Keys](https://docs.live2d.com/en/cubism-editor-manual/edit-parameters/), [Multiple Keys Editing](https://docs.live2d.com/en/cubism-editor-manual/multi-key/), [Keyforms](https://docs.live2d.com/en/cubism-editor-manual/keyform-xydirection/) | [Add 2 Keyforms] / [Add 3 Keyforms] at the top of the Parameter palette; green dots mark keys |
| Glue | [Glue](https://docs.live2d.com/en/cubism-editor-manual/glue/) | Glue weight 0–100 %; a higher weight gives that object's movement priority. The weight is not keyable per pose; only Glue applicability is |
| Parts / pose group | [Parts palette](https://docs.live2d.com/en/cubism-editor-manual/partspalatte/), [Pose Settings](https://docs.live2d.com/4.2/en/cubism-editor-manual/pose-setting/) | Parts with the same group number: only one is displayed. The manual places adding a pose under File > Add > Pose; confirm whether that is in the Editor or the Viewer in 5.3 |
| Mesh edits (only if needed) | [Edit Mesh manually](https://docs.live2d.com/en/cubism-editor-manual/mesh-edit-manual/) | — |
| Export | [Data for Embedded Use](https://docs.live2d.com/en/cubism-editor-manual/export-moc3-motion3-files/) | Export as moc3 file, with an export version choice |
| Shortcuts | [Shortcut list](https://docs.live2d.com/en/cubism-editor-manual/shortcut/) | Confirm any shortcut used |

## 1. Known facts (coordinator-verified) and unknowns

Known facts:
- Editor 5.3.04 works.
- G0 is accepted: after a native save, reopen and export (SDK 4.0 export), `ParamShoulder=0` matches and
  `ParamShoulder=1` differs in real WebGL.
- **Baseline for every G2 comparison:** the untouched G0-before export (the original, byte-identical to the
  sample moc3). The G0-after export is the deliberate +3° shoulder witness. At `ParamShoulder=1` it
  intentionally differs, so it is never a G2 baseline.
- The embedded PSD exports as 106 raster layers plus 17 groups, at 2976 × 4175.
- Eight right-arm source PNGs were extracted with exact RGBA equality. They stay local.
- Arm A (original) and arm B (bent) form **one mutually exclusive pose group**. B's temporary Editor
  visibility was turned off.
- The existing shoulder uses Glue.
- Observed right-arm chain: shoulder-shrug rotation → arm-A position → upper-arm rotation → forearm rotation,
  plus an upper-arm warp.
- The current original parameters cannot reach above the head.
- Generated shoulder and hand candidates have **not** passed native fitting. No further image generation is
  authorized.

Unknown until you observe and record it:
- the exact display names and IDs of those deformers and their parents;
- pivot positions;
- which existing parameters key each object, and at which values;
- the Glue pairs and weights;
- the Editor's positive angle direction for this chain;
- which parameter value produces each checkpoint pose.

Never copy a guessed value into the template.

## 2. Working copy and safety

1. Leave the untouched master `.cmo3` and the accepted G0 witness copy alone. Use **File > Save As** to make
   a new G2 working copy under an ignored local path, for example `model-work/hiyori-cubism/local/`. Nothing
   under `local/`, `source/` or `out/` is committed.
2. Record the SHA-256 of the master and of each saved working copy in the template. Record hashes only, not
   files.
3. Save numbered snapshots after each section (Save As `...-g2-01`, `-02`, …). A bad step is then undone by
   reopening the previous snapshot, not by chasing undo history.
4. Never upload the `.cmo3`, PSD, PNGs, textures, screenshots or exports.

## 3. Current value vs persistent keyform (read before editing)

- **Moving a slider** in the Parameter palette changes the parameter's *current value* only. It is a
  temporary view state; nothing is authored.
- **A keyform** is authored when the selected object has a key on the parameter (green dot) **and** the
  slider sits exactly on that key. Deforming the object then (angle, position, mesh, warp points) stores the
  shape in that keyform. It persists on save.
- **Between keys**, the Editor interpolates. Treat an edit made off-key as invalid; confirm the Editor's
  behaviour and never rely on it.
- **With several parameters keyed on one object**, keyforms exist for every *combination* of their keys. An
  edit only changes the combination the sliders currently sit on. Leaving an old parameter off its default
  while editing therefore edits a combination keyform you did not intend.
- **Ordinary angle editing** changes the rotation stored in the current keyform: drag the rotation handle, or
  type the angle in the inspector/tool-details field.
- **Ctrl+drag** moves or reorients the deformer's own position/angle **without moving its children**. This
  is pivot placement, not animation. Do it only at the neutral state (every parameter at default), and
  immediately check that the neutral render is unchanged. If a Ctrl+drag at a non-neutral key alters only
  that keyform, the pivot differs per pose; record which happened.

## 4. How not to change the old parameter keyforms

1. **Reset all parameters to their defaults** before every authoring step, and check `ParamShoulder` and the
   original arm parameters are at default. Record the reset control's exact label.
2. Put the new raise motion on a **new rotation deformer** keyed **only** by `ParamArmRaiseR`. Do not add
   `ParamArmRaiseR` keys to existing deformers in the first pass: that multiplies their keyform grid and
   invites accidental edits to old combinations.
3. Select exactly one object before adding keys, and confirm the Parameter palette shows keys only on the
   intended parameter.
4. After each edit, sweep every **old** arm parameter and `ParamShoulder` with `ParamArmRaiseR=0`. Compare
   with the **untouched G0-before (original) export**, not the +3° G0-after witness. Any difference means an old
   keyform was touched: reopen the last snapshot.
5. Corrective shape keys (section 6.6) go on **new** warp deformers keyed only by `ParamArmRaiseR`. An
   existing warp is edited only with a written reason.

## 5. Create the tentative parameter

Parameter palette → Create New Parameter:
- **ID:** `ParamArmRaiseR` (tentative; the ID is only proven when it appears in an exported moc3).
- **Name:** free text.
- **Type:** normal (Blend Shape unchecked).
- **Min** 0, **Max** 1, **Default** 0. Value 0 = the current hanging arm (neutral), 1 = overhead.

Checks and records:
- Check that no parameter with this ID already exists.
- Record the dialog labels and the resulting group placement.

## 6. Procedure

### 6.1 Inventory (no edits)

With all parameters at default, record the following in `inventory` in the template:
- the right-arm chain from the shoulder-shrug rotation down to the hand: display names, IDs and parents;
- each object's keyed parameters and key values;
- the Glue pairs and weights around the shoulder;
- arm-A/arm-B part membership and pose-group state.

### 6.2 Angle convention

- On a **scratch Save-As copy**, type a small positive angle into a rotation deformer and observe which way
  the arm turns on screen. Record that direction.
- Discard the scratch copy.
- Do not infer the sign from the other arm or from documentation.

### 6.3 Insert the raise deformer

1. Create a rotation deformer (confirm the menu label under Modeling/Deformer).
2. Make it the parent of the upper-arm rotation, so it sits between the arm-A position deformer and the
   upper-arm rotation, and the whole A arm inherits it. If the observed hierarchy makes another insertion point
   more correct, record why.
3. With every parameter at default, Ctrl+drag its pivot to the operator-judged shoulder joint centre (inside
   the cap). Record the angle the new deformer actually shows at neutral as the neutral reference; do not
   change it. Locally it has been observed as 0°, but that is a recorded observation, not a rule.
4. **Check the neutral image:** it must be pixel-identical to the pre-insertion snapshot. Use the local
   preview harness with `default` for before/after. If it differs, the insertion or pivot move changed the
   neutral: revert.

### 6.4 Keys on `ParamArmRaiseR` only

1. Select the new deformer and `ParamArmRaiseR`, then click [Add 2 Keyforms], giving keys at 0 and 1.
2. Add keys at intermediate values only where an intermediate checkpoint needs its own form, following the
   Add/Delete Keys page. Start with the fewest keys that give smooth motion. Record every key value.
3. **Key 0:** keep the recorded neutral reference angle from 6.3, whatever it is. Confirm the neutral image
   again after adding keys.
4. **Key 1:** with the slider exactly on 1, edit the angle until the hand is overhead. Use the direction
   observed in 6.2 and record the value you actually typed; there is no preset angle.
5. **Intermediate keys:** set the angle that places the arm at shoulder level and beside the head. Record the
   parameter value and the angle.

### 6.5 Shoulder, Glue and overlap inspection

At every checkpoint (section 7), and at every 0.1 step between them, inspect the shoulder cap / upper-sleeve
join:
- **Glue:** does the glued seam hold? Does the weight pull the cap or the sleeve?
  - The per-vertex Glue **weight** is a single, pose-independent setting. It cannot be keyed per pose, so a
    change affects every pose; re-check all checkpoints after any change and record why.
  - Only whether Glue **applies** can depend on the pose. Confirm the Editor's control for this in the Glue
    manual page, and record how it was used.
  - Pose-specific seam shaping belongs in warp keyforms (6.6), never in Glue weights.
- **Overlap:** is there intentional hidden overlap, or is joint art exposed that was never drawn?
- **Outline:** are there double outlines where two edges meet?
- **Sleeve:** does its thickness collapse or pinch?
- **Style:** does the stretched or rotated art still match Hiyori's line weight and shading?

Check all of these against both white and dark backgrounds.

### 6.6 Corrections (only if 6.5 shows a need)

- Add a **new** warp deformer around the cap/upper sleeve, keyed only by `ParamArmRaiseR`, at the same key
  values.
- Correct only at the keys that show the defect.
- Use a shoulder+elbow combination only where a real combined pose needs it, and record it.

### 6.7 Save, reopen, export, validate

1. Save, close and reopen. Confirm the parameter, keys and angles are still present.
2. Export moc3 at the version used for G0 (SDK 4.0), within the local Core's MocVersion ≤ 5.
3. Run `tools/audit-export.mjs` with the **untouched G0-before (original) export** as baseline, not the +3°
   G0-after witness. Use a poses file with
   `ParamArmRaiseR` **only after** the export shows the ID. Expect geometry change at non-zero values, and
   none at 0 against the baseline.
4. Run `tools/serve-native-preview.mjs` for a same-camera before/after in raw-Core mode, which shows both A
   and B arms.
5. Check the visible result with SDK Pose enabled in the real app or Viewer. This is a separate local step;
   the preview is raw-Core only.

## 7. Checkpoints (all must be reviewed, both directions)

| Checkpoint | `ParamArmRaiseR` | Meaning |
| --- | --- | --- |
| down | 0 | Must match the untouched G0-before (original) export's neutral |
| shoulder-level | recorded value | Upper arm roughly horizontal |
| beside-head | recorded value | Hand at head height beside the head |
| overhead | 1 | Hand above the head |
| return | 1 → 0 sweep | Same forms in reverse; no hysteresis |

- Also sweep 0 → 1 → 0 in 0.1 steps.
- Repeat `down` and `overhead` with `ParamShoulder` at 0 and at 1.
- The hand must reach head height. If it cannot without defects, that is a defect to report, not a reason to
  lower the target.

## 8. Switch-to-redraw criteria

Stop repairing and propose a redrawn assembly when any of these persists after one bounded correction pass
(6.6):
1. **Hidden joint art:** raising exposes armpit, cap-underside or sleeve-interior pixels that were never
   drawn.
2. **Double outlines:** two outlines at the cap/sleeve join that Glue weight and overlap cannot remove.
3. **Sleeve collapse:** sleeve thickness pinches or collapses at shoulder-level, beside-head or overhead.
4. **Style mismatch:** the rotated or warped original art no longer matches Hiyori's line weight or shading
   at the target poses.
5. **Old keyforms at risk:** reaching the range would require editing old keyforms in a way that changes
   existing parameter behaviour.

Record which criteria fired, with the checkpoint and parameter value. Screenshots stay local.

## 9. Replacing the old A arm with a redrawn assembly

Only after section 8 fires, and only with new art made by the separate image subagent that has **passed
native fitting**. No new generation is authorized by this document.

1. **Scope:** start with a coherent shoulder-to-hand right-arm assembly. Extend to the upper body, and only
   then the whole body, only when that is needed.
2. **Placement:** build the new ArtMeshes inside the **arm-A part** of a new Save-As copy, under the same
   raise-deformer chain. ArmA and ArmB are **one shared, bilateral** mutually exclusive pose group: each
   part holds both the left and the right arm of its set. Keeping the new right arm in arm A therefore keeps
   SDK Pose choosing one arm set (A or B) for both sides.
3. **Remove the old A art from rendering:** delete the old A ArtMeshes in that working copy, or move them to a
   part that is explicitly excluded from export. Record the choice. Do not rely on Editor eye-icon visibility,
   and do not leave old and new A both drawable.
4. **Expected counts:**

   | View | Character-right side | Total arms |
   | --- | --- | --- |
   | Raw-Core preview (SDK Pose off, diagnostic) | 2: new A + original B | 4 is legitimate, as the page warns |
   | Final Pose-enabled render | 1 | 2 |

   Any count above these (for example old A still drawable next to new A) is a defect. Verify the counts from
   drawable IDs in the audit report and visually.
5. Repeat sections 4–7 for the new assembly. An intentionally new assembly is **not** required to reproduce
   the old appearance or the old motion. Instead, record each difference against the untouched G0-before
   export as an explicit acceptance decision for the coordinator: neutral shape/colour/line, and the old
   arm-parameter motion. Differences are recorded, never hidden.

## 10. What completion does and does not mean

- A filled template, audit reports and preview captures are local evidence for review. They are not
  completion by themselves.
- Completion needs:
  - an exported moc3 containing the new parameter;
  - clean shoulder/sleeve at every checkpoint in real WebGL, with SDK Pose and in raw-Core mode;
  - old-parameter behaviour unchanged against the untouched G0-before export (repair path), or, for an
    accepted new assembly, each recorded difference explicitly accepted;
  - the coordinator's acceptance.
