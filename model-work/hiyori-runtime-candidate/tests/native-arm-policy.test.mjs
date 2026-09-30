import test from 'node:test';
import assert from 'node:assert/strict';
import {Live2DAvatar} from '../public/live2d-avatar.mjs';
import {motionPresets,motionArmPoseByModel} from '../public/motion-presets.mjs';
import {characters} from '../public/characters.mjs';

// A synthetic stand-in for the parts of pixi-live2d-display 0.4.0 and its pinned
// CubismWebFramework (1f9cdfd) that the native arm policy relies on. It checks
// renderer ordering and state only; it is not Core, WebGL or an accepted rig.
// - Declared parameters are Float32 values clamped to their range. Undeclared IDs
//   (the PartArm pose selectors) are synthesized at 0 and never saved or loaded.
// - Internal update order: motion curves, saveParameters, CubismPose fade (ported
//   doFade for one [PartArmA, PartArmB] group, 0.5 s, no Links), beforeModelUpdate
//   hooks, Core update, loadParameters.
// - Live2DModel.update only accumulates time; rendering the stage runs the update.
// - A motion stopped or superseded while loading never starts; destroy stops all.
// - The Idle curve plays whenever no other motion does and Idle is enabled.
// App presets that generated metadata marks raised select B like the current
// art and write a stub ParamArmRaiseR value; they are not accepted choreography.
const rigParameters=[
  ['ParamAngleX',-30,30,0],['ParamAngleY',-30,30,0],['ParamAngleZ',-30,30,0],
  ['ParamArmLA',-10,10,0],['ParamArmRA',-10,10,0],['ParamArmLB',-10,10,0],['ParamArmRB',-10,10,0],
  ['ParamHandL',-1,1,0],['ParamHandR',-1,1,0],['ParamHandLB',-10,10,10],['ParamHandRB',-10,10,10],
  ['ParamEyeLOpen',0,1,1],['ParamEyeROpen',0,1,1],['ParamEyeBallX',-1,1,0],['ParamEyeBallY',-1,1,0],
  ['ParamMouthOpenY',0,1,0],['ParamMouthForm',-1,1,0],
  ['ParamBrowLY',-1,1,0],['ParamBrowRY',-1,1,0],['ParamBrowLAngle',-1,1,0],['ParamBrowRAngle',-1,1,0]];
const raiseR=['ParamArmRaiseR',0,1,0];
const armParts=['PartUnrelated','PartArmB','PartArmA'];
const nativeRig=(changes={})=>({parameters:[...rigParameters,raiseR],parts:armParts,...changes});
const policy=()=>({version:1,visiblePart:'PartArmA',hiddenPart:'PartArmB',parameters:{ParamArmRaiseR:{min:0,default:0,max:1}}});
// Keeps Hiyori's id so the shared generated metadata, which selects B for
// happy/shy/surprised, is exercised. Only this local test object opts in.
const nativeHiyori={...characters.hiyori,modelURL:'/candidate/hiyori-native/model3.json',nativeArmPolicy:policy()};
const raisedPresets=motionPresets.filter(preset=>motionArmPoseByModel.hiyori[preset.id]==='raised');
const raisedPreset=raisedPresets[0];
const curves={
  raised:{PartArmA:0,PartArmB:1,ParamArmRaiseR:.8,ParamArmRB:6,ParamMouthOpenY:.9},
  normal:{ParamAngleY:-6,ParamMouthOpenY:.9},
  Tap:{PartArmA:0,PartArmB:1,ParamArmRB:7},
  Idle:{PartArmA:0,PartArmB:1,ParamArmLB:2}};

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
function frame(extra={}){return {state:'speaking',expression:'happy',gesture:'none',head:'still',gaze:'forward',intensity:1,
  epoch:1,inputSeq:1,turnId:'reply-1',expiresAt:1e6,...extra};}
function near(actual,expected,message=''){assert.ok(Math.abs(actual-expected)<1e-6,`${message}: expected ${expected}, got ${actual}`);}
function assertA(rendered,message=''){
  assert.equal(rendered.opacities.get('PartArmA'),1,`${message} A visible`);assert.equal(rendered.opacities.get('PartArmB'),0,`${message} B hidden`);
  assert.equal(rendered.selectors.PartArmA,1,`${message} A selected`);assert.equal(rendered.selectors.PartArmB,0,`${message} B not selected`);
  assert.equal(rendered.opacities.get('PartUnrelated'),.625,`${message} unrelated part untouched`);
}

function createCore(rig){
  const ids=rig.parameters.map(([id])=>id),column=index=>Float32Array.from(rig.parameters,spec=>spec[index]);
  const parameters={ids,count:ids.length,minimumValues:column(1),maximumValues:column(2),defaultValues:column(3),values:column(3)};
  const parts=rig.parts&&{ids:[...rig.parts],count:rig.parts.length,opacities:Float32Array.from(rig.parts,id=>id==='PartUnrelated'?.625:1)};
  const synthesized=new Map();let saved=parameters.values.slice();
  const core={
    declares:id=>ids.includes(id),
    getModel:()=>({parameters,parts}),
    getParameterValueById(id){const index=ids.indexOf(id);return index<0?(synthesized.get(id)??0):parameters.values[index];},
    setParameterValueById(id,value){
      assert.ok(Number.isFinite(value),`non-finite ${id}`);
      const index=ids.indexOf(id);
      if(index>=0)parameters.values[index]=Math.min(parameters.maximumValues[index],Math.max(parameters.minimumValues[index],value));
      else{assert.ok(['PartArmA','PartArmB'].includes(id),`unexpected synthesized parameter ${id}`);synthesized.set(id,value);}
    },
    addParameterValueById(id,value){core.setParameterValueById(id,core.getParameterValueById(id)+value);},
    savedValue:id=>saved[ids.indexOf(id)],
    saveParameters(){saved=parameters.values.slice();},
    loadParameters(){parameters.values.set(saved);},
    snapshot:()=>({values:new Map(ids.map((id,index)=>[id,parameters.values[index]])),
      selectors:{PartArmA:core.getParameterValueById('PartArmA'),PartArmB:core.getParameterValueById('PartArmB')},
      opacities:new Map(parts?Array.from(parts.ids,(id,index)=>[id,parts.opacities[index]]):[])})};
  return core;
}
// CubismPose.reset on the first update, then doFade every update.
function createPose(core){
  const parts=core.getModel().parts,ids=['PartArmA','PartArmB'];
  const indices=ids.map(id=>parts?parts.ids.indexOf(id):-1);
  if(indices.includes(-1))return null;
  let initialized=false;
  return {update(dt){
    if(!initialized){initialized=true;ids.forEach((id,i)=>{parts.opacities[indices[i]]=i===0?1:0;core.setParameterValueById(id,i===0?1:0);});}
    let visible=-1,opacity=1;
    for(let i=0;i<ids.length;i++){
      if(core.getParameterValueById(ids[i])<=.001)continue;
      if(visible>=0)break;
      visible=i;opacity=Math.min(1,parts.opacities[indices[i]]+dt/.5);
    }
    if(visible<0){visible=0;opacity=1;}
    for(let i=0;i<ids.length;i++){
      if(i===visible){parts.opacities[indices[i]]=opacity;continue;}
      let a1=opacity<.5?opacity*(.5-1)/.5+1:(1-opacity)*.5/(1-.5);
      if((1-a1)*(1-opacity)>.15)a1=1-.15/(1-opacity);
      parts.opacities[indices[i]]=Math.min(parts.opacities[indices[i]],a1);
    }
  }};
}

function fixture(t,{rigs={},motionResult=()=>true}={}){
  const f={rigs:{[nativeHiyori.modelURL]:nativeRig(),[characters.hiyori.modelURL]:{parameters:rigParameters,parts:armParts},
    [characters.chitose.modelURL]:{parameters:rigParameters,parts:['PartUnrelated']},...rigs},
  models:[],loads:[],motions:[],frames:[],statuses:[],errors:[],motionEnds:[],fetches:0,animationFrames:0,clock:0};
  const curveOf=motion=>motion.group!=='App'?curves[motion.group]:
    curves[motionArmPoseByModel.hiyori[motionPresets.find(preset=>preset.group==='App'&&preset.index===motion.index).id]];
  function createInternalModel(rig){
    const core=createCore(rig),pose=createPose(core),hooks=[];
    const manager={groups:{idle:'Idle'},definitions:{App:motionPresets.map(()=>({})),Tap:[{}],Idle:[{}]},current:null,reserved:null,
      expressionManager:{reserveExpressionIndex:-1,definitions:[],resetExpression(){},on(){}},
      on(){},stopAllMotions(){this.current=null;this.reserved=null;}};
    return {coreModel:core,motionManager:manager,focusController:{focus(){}},width:400,height:800,hooks,
      settings:{getLipSyncParameters:()=>['ParamMouthOpenY'],getEyeBlinkParameters:()=>['ParamEyeLOpen','ParamEyeROpen']},
      on(name,listener){if(name==='beforeModelUpdate')hooks.push(listener);},
      update(dt){
        const motion=manager.current||(manager.definitions[manager.groups.idle]?{group:'Idle'}:null);
        for(const [id,value]of Object.entries(motion?curveOf(motion):{}))if(id.startsWith('PartArm')||core.declares(id))core.setParameterValueById(id,value);
        core.saveParameters();
        pose?.update(dt/1000);
        const sdk=core.snapshot();
        for(const hook of hooks)hook();
        f.frames.push({...core.snapshot(),sdk});
        core.loadParameters();
      }};
  }
  class Live2DModel{
    constructor(options){this.options=options;this.textures=[];this.listeners=new Map();this.deltaTime=0;this.destroyed=[];
      this.anchor={set(){}};this.scale={set(){}};this.position={set(){}};f.models.push(this);}
    once(name,listener){this.listeners.set(name,listener);}
    emit(name,...args){const listener=this.listeners.get(name);this.listeners.delete(name);listener?.(...args);}
    update(dt){this.deltaTime+=dt;}
    motion(group,index,priority){
      const manager=this.internalModel.motionManager;
      if(!manager.definitions[group]?.[index])return Promise.resolve(false);
      const motion={group,index};manager.reserved=motion;f.motions.push({group,index,priority});
      return Promise.resolve(motionResult(f.motions.length)).then(loaded=>{
        if(!loaded||manager.reserved!==motion)return false;
        manager.reserved=null;manager.current=motion;return true;
      });
    }
    expression(){}
    destroy(options){this.destroyed.push(options);this.internalModel?.motionManager.stopAllMotions();}
    unregisterInteraction(){}
  }
  class Application{
    constructor(){
      this.stage={children:[],addChild(child){this.children.push(child);},removeChild(child){this.children=this.children.filter(item=>item!==child);}};
      // Like Live2DModel._render, the internal update runs only for accumulated time.
      this.renderer={plugins:{},resize(){},clear(){},render(stage){
        for(const model of stage.children)if(model.deltaTime){const dt=model.deltaTime;model.deltaTime=0;model.internalModel.update(dt);}
      }};
    }
    stop(){}
    destroy(){this.destroyed=true;}
  }
  const PIXI={Application,Container:{prototype:{destroy(){}}},Texture:{from:()=>({destroy(){}}),fromURL:async()=>({destroy(){}})},
    live2d:{config:{},Live2DModel,Live2DFactory:{async setupLive2DModel(model,url){
      f.loads.push(url);model.emit('settingsLoaded',{textures:[],resolveURL:file=>file});
      assert.ok(f.rigs[url],`no synthetic rig for ${url}`);model.internalModel=createInternalModel(f.rigs[url]);
    }}}};
  const globals={PIXI,Live2DCubismCore:{},devicePixelRatio:1,requestAnimationFrame:()=>++f.animationFrames,cancelAnimationFrame(){},
    fetch:async()=>{f.fetches++;throw new Error('no network in this test');}};
  const saved=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  const avatar=new Live2DAvatar({canvas:{parentElement:{clientWidth:210,clientHeight:350}},now:()=>f.clock,
    onError:error=>f.errors.push(error),onStatus:status=>f.statuses.push(status),onMotionEnd:reason=>f.motionEnds.push(reason)});
  t.after(async()=>{await avatar.destroy();for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return Object.assign(f,{avatar,
    select:character=>avatar.select(character),
    core:()=>avatar.model.internalModel.coreModel,
    manager:()=>avatar.model.internalModel.motionManager,
    // The same two calls as renderOnce()/tick(), with an explicit SDK time step.
    render(dt=50){avatar.model.update(dt);avatar.app.renderer.render(avatar.app.stage);return f.frames.at(-1);},
    tick(ms=50){f.clock+=ms;avatar.tick(f.clock);return f.frames.at(-1);}});
}

test('shipped characters do not opt in and policy-free models keep their previous arm behavior',async t=>{
  for(const character of Object.values(characters))assert.equal(Object.hasOwn(character,'nativeArmPolicy'),false,character.name);
  for(const [name,character]of [['Hiyori',characters.hiyori],['explicitly undefined',{...characters.hiyori,nativeArmPolicy:undefined}]])await t.test(name,async child=>{
    const f=fixture(child);await f.select(character);
    assert.deepEqual(f.statuses,['loading','ready']);assert.deepEqual(f.errors,[]);assert.equal(f.avatar.nativeArm,null);
    // Outside performance mode the SDK Idle keeps selecting B, as before.
    let rendered;for(let i=0;i<20;i++)rendered=f.tick();
    assert.equal(rendered.opacities.get('PartArmB'),1);assert.equal(rendered.opacities.get('PartArmA'),0);
    // Generated metadata still selects B for a raised App gesture.
    f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));await settle();
    assert.equal(f.avatar.armPose.mode,'raised');
    f.avatar.elapsed=f.avatar.armPose.at+.3;rendered=f.render();
    assert.equal(rendered.opacities.get('PartArmB'),1);assert.equal(rendered.opacities.get('PartArmA'),0);assert.equal(rendered.selectors.PartArmB,1);
  });
  await t.test('Chitose without arm parts',async child=>{
    const f=fixture(child);await f.select(characters.chitose);
    assert.deepEqual(f.statuses,['loading','ready']);assert.deepEqual(f.errors,[]);
    f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));await settle();
    assert.equal(f.motions.length,1);assert.equal(f.avatar.nativeArm,null);assert.equal(f.avatar.armPose,null);assert.equal(f.avatar.getArmRig(),null);
  });
});

test('a valid opt-in is checked against the loaded Core and owns A from its first render',async t=>{
  const frozen=Object.freeze(Object.assign(Object.create(null),{version:1,visiblePart:'PartArmA',hiddenPart:'PartArmB',
    parameters:Object.freeze({ParamArmRaiseR:Object.freeze({min:0,default:0,max:1})})}));
  const cases=[
    ['SDK-synthesized selectors',nativeRig(),policy()],
    ['declared selectors',nativeRig({parameters:[...rigParameters,raiseR,['PartArmA',0,1,1],['PartArmB',0,1,0]]}),policy()],
    ['frozen configuration',nativeRig(),frozen]];
  for(const [name,rig,value]of cases)await t.test(name,async child=>{
    const f=fixture(child,{rigs:{[nativeHiyori.modelURL]:rig}});await f.select({...nativeHiyori,nativeArmPolicy:value});
    assert.deepEqual(f.statuses,['loading','ready']);assert.deepEqual(f.errors,[]);
    assert.deepEqual(f.loads,[nativeHiyori.modelURL]);assert.equal(f.fetches,0);assert.equal(f.animationFrames,1,'one animation ticker');
    assert.equal(f.avatar.nativeArm.model,f.avatar.model);assert.deepEqual(f.avatar.nativeArm.parameterIds,['ParamArmRaiseR']);
    assertA(f.frames[0],'initial render');
    for(let i=0;i<20;i++){const rendered=f.tick();assertA(rendered,`frame ${i}`);assert.equal(rendered.values.get('ParamArmRaiseR'),0);}
  });
});

test('a malformed policy fails clearly before any model is requested',async t=>{
  const base=policy(),range=value=>({...base,parameters:{ParamArmRaiseR:value}});
  const cases=[
    ['null',null],['string','ArmA'],['array',[base]],['empty',{}],['version 2',{...base,version:2}],['string version',{...base,version:'1'}],
    ['extra field',{...base,parts:{PartArmB:1}}],['missing hidden part',{version:1,visiblePart:'PartArmA',parameters:base.parameters}],
    ['swapped parts',{...base,visiblePart:'PartArmB',hiddenPart:'PartArmA'}],['no parameters',{...base,parameters:{}}],
    ['extra parameter',{...base,parameters:{...base.parameters,ParamArmRaiseL:{min:0,default:0,max:1}}}],
    ['wider range',range({min:0,default:0,max:2})],['missing default',range({min:0,max:1})],['string bound',range({min:'0',default:0,max:1})],
    ['class instance',Object.assign(new (class Policy{})(),base)]];
  for(const [name,value]of cases)await t.test(name,async child=>{
    const f=fixture(child);await f.select({...nativeHiyori,nativeArmPolicy:value});
    assert.deepEqual(f.statuses,['loading','error']);assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/nativeArmPolicy/);
    assert.deepEqual(f.loads,[]);assert.equal(f.models.length,0,'no model instance was created');assert.equal(f.fetches,0);
    assert.equal(f.avatar.model,null);assert.equal(f.avatar.nativeArm,null);assert.equal(f.animationFrames,0);
  });
});

test('a loaded rig that does not match its policy is disposed, never attached, and does not block a retry',async t=>{
  const raise=spec=>nativeRig({parameters:[...rigParameters,spec]});
  const cases=[
    ['missing parameter',nativeRig({parameters:rigParameters}),'ParamArmRaiseR'],
    ['alias only',raise(['PARAM_ARM_RAISE_R',0,1,0]),'ParamArmRaiseR'],
    ['negative minimum',raise(['ParamArmRaiseR',-1,1,0]),'ParamArmRaiseR'],
    ['larger maximum',raise(['ParamArmRaiseR',0,30,0]),'ParamArmRaiseR'],
    ['raised default',raise(['ParamArmRaiseR',0,1,1]),'ParamArmRaiseR'],
    ['missing ArmA',nativeRig({parts:['PartUnrelated','PartArmB']}),'PartArmA'],
    ['missing ArmB',nativeRig({parts:['PartUnrelated','PartArmA']}),'PartArmB'],
    ['no part data',nativeRig({parts:null}),'PartArmA'],
    ['clamping selector',nativeRig({parameters:[...rigParameters,raiseR,['PartArmB',0,.5,0]]}),'PartArmB']];
  for(const [name,rig,detail]of cases)await t.test(name,async child=>{
    const f=fixture(child,{rigs:{[nativeHiyori.modelURL]:rig}});await f.select(nativeHiyori);
    assert.deepEqual(f.statuses,['loading','error']);assert.equal(f.errors.length,1);
    assert.ok(f.errors[0].message.includes(detail),f.errors[0].message);
    assert.equal(f.models.length,1);const [model]=f.models;
    assert.deepEqual(model.destroyed,[{children:true,texture:true,baseTexture:true}],'destroyed once with its textures');
    assert.equal(model.internalModel.hooks.length,0,'no update hook was installed');
    assert.equal(f.avatar.app.stage.children.length,0);assert.equal(f.avatar.model,null);assert.equal(f.avatar.nativeArm,null);
    assert.equal(f.animationFrames,0);
    f.rigs[nativeHiyori.modelURL]=nativeRig();await f.select(nativeHiyori);
    assert.equal(f.statuses.at(-1),'ready');assert.equal(f.errors.length,1);assertA(f.render(),'retry');
  });
});

test('legacy Tap and SDK Idle selector curves are overridden after every SDK update on an opted-in rig',async t=>{
  const f=fixture(t);await f.select(nativeHiyori);
  const check=(label,count)=>{for(let i=0;i<count;i++){
    const rendered=f.tick();
    assert.equal(rendered.sdk.selectors.PartArmB,1,`${label} ${i}: this SDK update selected B`);
    assert.ok(rendered.sdk.opacities.get('PartArmB')>0,`${label} ${i}: the SDK pose began to show B`);
    assertA(rendered,`${label} ${i}`);
  }};
  check('Idle',20);
  f.avatar.react('happy');await settle();
  assert.deepEqual(f.motions.at(-1),{group:'Tap',index:0,priority:3});assert.equal(f.manager().current.group,'Tap');
  check('Tap',20);
  assert.equal(f.core().getParameterValueById('PartArmB'),0,'the SDK reload does not restore a synthesized B selector');
});

test('App gestures whose generated metadata selects B keep A while ParamArmRaiseR follows the owned intensity path',async t=>{
  assert.ok(raisedPresets.length>0);
  for(const preset of raisedPresets)for(const intensity of [1,.5])await t.test(`${preset.id} at ${intensity}`,async child=>{
    const f=fixture(child);await f.select(nativeHiyori);
    f.avatar.applyPerformance(frame({gesture:preset.id,intensity}));await settle();
    assert.deepEqual(f.motions.at(-1),{group:'App',index:preset.index,priority:3});assert.deepEqual(f.manager().current,{group:'App',index:preset.index});
    assert.equal(f.avatar.armPose,null,'the metadata did not start a B pose');
    assert.ok(f.avatar.performanceGesture.parameters.has('paramarmraiser'));
    const start=f.avatar.elapsed;f.avatar.mouth=.4;
    for(const at of [.05,.3,preset.duration-.05]){
      f.avatar.elapsed=start+at;const rendered=f.render();
      assert.equal(rendered.sdk.selectors.PartArmB,1,'the App curve selected B in this SDK update');
      assertA(rendered,`${at}s`);
      near(rendered.values.get('ParamArmRaiseR'),.8*intensity,'RaiseR');near(rendered.values.get('ParamMouthOpenY'),.4,'mouth');
    }
  });
});

test('manual preview of a raised preset keeps A and its completion returns ParamArmRaiseR to the default',async t=>{
  const f=fixture(t);await f.select(nativeHiyori);
  assert.equal(await f.avatar.playMotion(raisedPreset),true);assert.equal(f.avatar.armPose,null);
  const start=f.avatar.elapsed;f.avatar.mouth=.4;
  for(const at of [.1,.3,raisedPreset.duration-.1]){
    f.avatar.elapsed=start+at;const rendered=f.render();
    assert.equal(rendered.sdk.selectors.PartArmB,1);assertA(rendered,`${at}s`);
    near(rendered.values.get('ParamArmRaiseR'),.8,'preview plays the authored value');near(rendered.values.get('ParamMouthOpenY'),.4,'mouth');
  }
  f.avatar.elapsed=start+raisedPreset.duration+.2;f.tick();
  assert.deepEqual(f.motionEnds,['complete']);assert.equal(f.avatar.preview,false);
  assert.equal(f.core().savedValue('ParamArmRaiseR'),0,'the saved raised value is cleared');
  for(let i=0;i<10;i++){const rendered=f.tick();assertA(rendered,`after ${i}`);assert.equal(rendered.values.get('ParamArmRaiseR'),0);}
});

test('stale motion completions cannot revive B or a raised ParamArmRaiseR',async t=>{
  const cases=[
    ['listening interrupts a loading gesture','performance',f=>f.avatar.applyPerformance(frame({state:'listening',expression:'calm',inputSeq:2}))],
    ['a newer normal gesture supersedes it','performance',f=>f.avatar.applyPerformance(frame({gesture:'nod',inputSeq:2,turnId:'reply-2'}))],
    ['preview cancel','preview',f=>f.avatar.stopPreview('interrupted')],
    ['reduced motion','preview',f=>f.avatar.setReducedMotion(true)],
    ['model switch','performance',f=>f.select(nativeHiyori)],
    ['destroy','performance',f=>f.avatar.destroy()]];
  for(const [name,mode,interrupt]of cases)await t.test(name,async child=>{
    const pending=deferred(),f=fixture(child,{motionResult:call=>call===1?pending.promise:true});
    await f.select(nativeHiyori);const model=f.avatar.model,manager=f.manager();
    const opening=mode==='preview'?f.avatar.playMotion(raisedPreset):f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));
    await interrupt(f);pending.resolve(true);await settle();
    if(mode==='preview')assert.equal(await opening,false);
    assert.notDeepEqual(manager.current,{group:'App',index:raisedPreset.index},'the stale raised motion never started');
    assert.equal(f.avatar.armPose,null);assert.equal(f.avatar.preview,false);assert.deepEqual(f.errors,[]);
    if(!f.avatar.model){assert.equal(model.destroyed.length,1);return;}
    if(name==='model switch'){assert.notEqual(f.avatar.model,model);assert.equal(model.destroyed.length,1);}
    for(let i=0;i<10;i++){const rendered=f.tick();assertA(rendered,`${name} ${i}`);assert.equal(rendered.values.get('ParamArmRaiseR'),0);}
  });
});

test('ordinary release eases ParamArmRaiseR, lifecycle resets are immediate, and neither revives it after the SDK reload',async t=>{
  async function raised(child){
    const f=fixture(child);await f.select(nativeHiyori);
    f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));await settle();
    f.avatar.mouth=.4;f.avatar.elapsed+=.3;
    const rendered=f.render();assertA(rendered,'raised');near(rendered.values.get('ParamArmRaiseR'),.8,'raised');
    return f;
  }
  const ordinary=[
    ['listening',f=>{f.avatar.applyPerformance(frame({state:'listening',expression:'calm',inputSeq:2}));return f.render();}],
    ['gesture end',f=>{f.avatar.elapsed=f.avatar.performanceGesture.until;return f.tick();}],
    ['frame deadline',f=>{f.clock=f.avatar.performanceFrame.expiresAt-1;return f.tick(1);}]];
  for(const [name,stop]of ordinary)await t.test(`ordinary: ${name}`,async child=>{
    const f=await raised(child),boundary=stop(f),release=f.avatar.performanceRelease;
    assert.equal(f.avatar.performanceGesture,null);assert.ok(release);
    assert.ok(release.from.has('paramarmraiser'));assert.equal(release.from.has('parammouthopeny'),false);
    assert.equal(f.core().savedValue('ParamArmRaiseR'),0,'the saved value is neutral immediately');
    assertA(boundary,'boundary');near(boundary.values.get('ParamArmRaiseR'),.8,'no visible snap');
    f.avatar.elapsed=release.at+.14;let rendered=f.render();assertA(rendered,'middle');near(rendered.values.get('ParamArmRaiseR'),.4,'middle');
    f.avatar.elapsed=release.at+.28;rendered=f.render();assert.equal(rendered.values.get('ParamArmRaiseR'),0);assert.equal(f.avatar.performanceRelease,null);
    for(let i=0;i<20;i++){rendered=f.render();assertA(rendered,`after ${i}`);assert.equal(rendered.values.get('ParamArmRaiseR'),0,'the SDK reload cannot revive it');}
  });
  const immediate=[
    ['disconnected',f=>f.avatar.applyPerformance(frame({state:'disconnected',expression:'calm',inputSeq:2,expiresAt:null}))],
    ['reduced motion',f=>f.avatar.setReducedMotion(true)],
    ['inactive',f=>f.avatar.setActive(false)],
    ['legacy reaction',f=>f.avatar.react('calm')],
    ['model switch',f=>f.select(nativeHiyori)],
    ['destroy',f=>f.avatar.destroy()]];
  for(const [name,stop]of immediate)await t.test(`immediate: ${name}`,async child=>{
    const f=await raised(child),model=f.avatar.model;
    await stop(f);
    assert.equal(f.avatar.performanceGesture,null);assert.equal(f.avatar.performanceRelease,null);assert.equal(f.avatar.armPose,null);
    if(!f.avatar.model){assert.deepEqual(model.destroyed,[{children:true,texture:true,baseTexture:true}]);assert.equal(f.avatar.nativeArm,null);return;}
    if(f.avatar.model===model)assert.equal(f.core().savedValue('ParamArmRaiseR'),0,'the saved value is reset synchronously');
    else{assert.equal(model.destroyed.length,1);assert.equal(f.avatar.nativeArm.model,f.avatar.model,'the new model was validated again');}
    for(let i=0;i<20;i++){const rendered=f.render();assertA(rendered,`${name} ${i}`);assert.equal(rendered.values.get('ParamArmRaiseR'),0);}
  });
});

test('the audible mouth level is not owned or changed by a native arm gesture, its release or a reset',async t=>{
  const f=fixture(t);await f.select(nativeHiyori);
  f.avatar.applyPerformance(frame({gesture:raisedPreset.id,intensity:.8}));await settle();
  assert.equal(f.avatar.performanceGesture.parameters.has('parammouthopeny'),false);
  f.avatar.mouth=.4;f.avatar.elapsed+=.3;
  const rendered=f.render();near(rendered.values.get('ParamMouthOpenY'),.4,'gesture');near(rendered.values.get('ParamArmRaiseR'),.64,'scaled arm');
  f.avatar.applyPerformance(frame({state:'listening',expression:'calm',inputSeq:2}));
  assert.equal(f.avatar.mouth,.4,'stopping the arm does not touch the mouth level');
  assert.equal(f.avatar.performanceRelease.from.has('parammouthopeny'),false);
  for(const step of [0,.1,.1,.1]){f.avatar.elapsed+=step;near(f.render().values.get('ParamMouthOpenY'),.4,`release +${step}`);}
  f.avatar.mouth=.65;near(f.render().values.get('ParamMouthOpenY'),.65,'a new level is not delayed by the arm');
  f.avatar.applyPerformance(frame({state:'disconnected',expression:'calm',inputSeq:3,expiresAt:null}));
  assert.equal(f.avatar.mouth,.65);near(f.render().values.get('ParamMouthOpenY'),.65,'immediate reset');
});

test('switching between an opted-in rig and a policy-free Hiyori neither leaks nor loses the policy',async t=>{
  const f=fixture(t);
  await f.select(nativeHiyori);assertA(f.tick(),'native');const nativeModel=f.avatar.model;
  await f.select(characters.hiyori);assert.equal(f.avatar.nativeArm,null);
  f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));await settle();
  assert.equal(f.avatar.armPose.mode,'raised');
  f.avatar.elapsed=f.avatar.armPose.at+.3;
  const legacy=f.render();assert.equal(legacy.opacities.get('PartArmB'),1,'the policy-free rig keeps its B drawing');assert.equal(legacy.opacities.get('PartArmA'),0);
  await f.select(nativeHiyori);assert.notEqual(f.avatar.model,nativeModel);assert.equal(f.avatar.armPose,null);
  for(let i=0;i<10;i++)assertA(f.tick(),`native again ${i}`);
});
