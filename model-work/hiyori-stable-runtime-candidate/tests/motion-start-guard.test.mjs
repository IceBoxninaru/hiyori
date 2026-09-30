import test from 'node:test';
import assert from 'node:assert/strict';
import {Live2DAvatar} from '../public/live2d-avatar.mjs';
import {motionPresets,motionArmPoseByModel} from '../public/motion-presets.mjs';
import {characters} from '../public/characters.mjs';

// Policy-free stable-renderer tests for the async motion-start guard. The fixture
// is taken from the reviewed native candidate's SDK-faithful fixture without the
// native arm policy. It is a synthetic stand-in for pixi-live2d-display 0.4.0 and
// CubismWebFramework 1f9cdfd; it checks renderer ordering and state only and is
// not Core or WebGL.
// - Declared parameters are Float32 values clamped to their range. Undeclared IDs
//   (the PartArm pose selectors) are synthesized at 0 and never saved or loaded.
// - Internal update order: motion curves, saveParameters, CubismPose fade (ported
//   doFade for one [PartArmA, PartArmB] group, 0.5 s, no Links), beforeModelUpdate
//   hooks, Core update, loadParameters.
// - Live2DModel.update only accumulates time; rendering the stage runs the update.
// - Motion start, loading and Idle follow the MotionState/MotionManager model below.
// App presets that generated metadata marks raised select B like the current art.
const rigParameters=[
  ['ParamAngleX',-30,30,0],['ParamAngleY',-30,30,0],['ParamAngleZ',-30,30,0],
  ['ParamArmLA',-10,10,0],['ParamArmRA',-10,10,0],['ParamArmLB',-10,10,0],['ParamArmRB',-10,10,0],
  ['ParamHandL',-1,1,0],['ParamHandR',-1,1,0],['ParamHandLB',-10,10,10],['ParamHandRB',-10,10,10],
  ['ParamEyeLOpen',0,1,1],['ParamEyeROpen',0,1,1],['ParamEyeBallX',-1,1,0],['ParamEyeBallY',-1,1,0],
  ['ParamMouthOpenY',0,1,0],['ParamMouthForm',-1,1,0],
  ['ParamBrowLY',-1,1,0],['ParamBrowRY',-1,1,0],['ParamBrowLAngle',-1,1,0],['ParamBrowRAngle',-1,1,0]];
const armParts=['PartUnrelated','PartArmB','PartArmA'];
const raisedPresets=motionPresets.filter(preset=>motionArmPoseByModel.hiyori[preset.id]==='raised');
const raisedPreset=raisedPresets[0];
const curves={
  raised:{PartArmA:0,PartArmB:1,ParamArmRB:6,ParamMouthOpenY:.9},
  normal:{ParamAngleY:-6,ParamMouthOpenY:.9},
  Tap:{PartArmA:0,PartArmB:1,ParamArmRB:7},
  Idle:{PartArmA:0,PartArmB:1,ParamArmLB:2}};

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
function frame(extra={}){return {state:'speaking',expression:'happy',gesture:'none',head:'still',gaze:'forward',intensity:1,
  epoch:1,inputSeq:1,turnId:'reply-1',expiresAt:1e6,...extra};}
function near(actual,expected,message=''){assert.ok(Math.abs(actual-expected)<1e-6,`${message}: expected ${expected}, got ${actual}`);}
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

// Behavioural model (not a copy) of pixi-live2d-display 0.4.0 MotionState,
// MotionManager.startMotion/loadMotion/update and Live2DFactory.loadMotion with
// config.sound=false. Reservations are keyed by group/index; startMotion reads
// this.state again after the load; start() consumes a matching reservation
// before checking the motion; Idle has its own reservation; one pending load is
// shared per actual manager and pair; a failed load emits motionLoadError and
// resolves undefined. Idle picks the first available index instead of a random one.
const IDLE=1;
class MotionState{
  constructor(){this.reset();}
  reserve(group,index,priority){
    if(priority<=0||group===this.currentGroup&&index===this.currentIndex)return false;
    if(group===this.reservedGroup&&index===this.reservedIndex||group===this.reservedIdleGroup&&index===this.reservedIdleIndex)return false;
    if(priority===IDLE){
      if(this.currentPriority!==0||this.reservedIdleGroup!==undefined)return false;
      this.reservedIdleGroup=group;this.reservedIdleIndex=index;
    }else{
      if(priority<3&&(priority<=this.currentPriority||priority<=this.reservePriority))return false;
      this.reservedGroup=group;this.reservedIndex=index;this.reservePriority=priority;
    }
    return true;
  }
  start(motion,group,index,priority){
    if(priority===IDLE){this.reservedIdleGroup=this.reservedIdleIndex=undefined;if(this.currentPriority!==0)return false;}
    else{
      if(group!==this.reservedGroup||index!==this.reservedIndex)return false;
      this.reservedGroup=this.reservedIndex=undefined;this.reservePriority=0;
    }
    if(!motion)return false;
    this.currentGroup=group;this.currentIndex=index;this.currentPriority=priority;return true;
  }
  complete(){this.currentGroup=this.currentIndex=undefined;this.currentPriority=0;}
  reset(){this.complete();this.reservedGroup=this.reservedIndex=this.reservedIdleGroup=this.reservedIdleIndex=undefined;this.reservePriority=0;}
  isActive(group,index){return group===this.currentGroup&&index===this.currentIndex||group===this.reservedGroup&&index===this.reservedIndex||
    group===this.reservedIdleGroup&&index===this.reservedIdleIndex;}
  shouldRequestIdleMotion(){return this.currentGroup===undefined&&this.reservedIdleGroup===undefined;}
  shouldOverrideExpression(){return this.currentPriority>IDLE;}
}
class MotionManager{
  constructor(f){
    this.f=f;this.state=new MotionState();this.groups={idle:'Idle'};this.playing=false;this.entry=null;this.destroyed=false;
    this.definitions={App:motionPresets.map(()=>({})),Tap:[{}],Idle:[{}]};this.motionGroups={};this.tasks={};this.events={};
    this.expressionManager={reserveExpressionIndex:-1,definitions:[],resetExpression(){},restoreExpression(){},on(){}};
  }
  on(name,listener){(this.events[name]??=[]).push(listener);}
  emit(name,...args){for(const listener of [...(this.events[name]||[])])listener(...args);}
  async loadMotion(group,index){
    const key=`${group}:${index}`;
    if(!this.definitions[group]?.[index]||this.motionGroups[key]===null)return undefined;
    if(this.motionGroups[key])return this.motionGroups[key];
    const motion=await this._loadMotion(group,index);
    if(this.destroyed)return undefined;
    this.motionGroups[key]=motion??null;
    return motion;
  }
  _loadMotion(group,index){
    const key=`${group}:${index}`;
    this.tasks[key]??=(this.f.motionLoads.push(key),Promise.resolve(this.f.motionLoad(group,index))).then(result=>{
      delete this.tasks[key];
      if(result===null)throw new Error(`synthetic load failure ${key}`);
      return {group,index};
    }).catch(error=>{this.emit('motionLoadError',group,index,error);return undefined;});
    return this.tasks[key];
  }
  async startMotion(group,index,priority=2){
    if(!this.state.reserve(group,index,priority))return false;
    if(!this.definitions[group]?.[index])return false;
    const motion=await this.loadMotion(group,index);
    if(!this.state.start(motion,group,index,priority))return false;
    this.emit('motionStart',group,index,undefined);
    if(this.state.shouldOverrideExpression())this.expressionManager.resetExpression();
    this.playing=true;
    this._startMotion(motion);
    return true;
  }
  async startRandomMotion(group,priority){
    const index=(this.definitions[group]||[]).findIndex((definition,i)=>this.motionGroups[`${group}:${i}`]!==null&&!this.state.isActive(group,i));
    return index<0?false:this.startMotion(group,index,priority);
  }
  _startMotion(motion){this.entry={motion,finished:false};this.f.started.push({manager:this,group:motion.group,index:motion.index});return 1;}
  stopAllMotions(){this.entry=null;this.state.reset();}
  update(){
    if(!this.entry||this.entry.finished){
      if(this.playing){this.playing=false;this.emit('motionFinish');}
      this.state.complete();
      if(this.state.shouldRequestIdleMotion())this.startRandomMotion(this.groups.idle,IDLE);
    }
    return this.entry&&!this.entry.finished?this.entry.motion:null;
  }
  destroy(){this.destroyed=true;this.emit('destroy');this.stopAllMotions();}
}

function fixture(t,{rigs={},motionLoad=()=>true}={}){
  const f={rigs:{[characters.hiyori.modelURL]:{parameters:rigParameters,parts:armParts},
    [characters.chitose.modelURL]:{parameters:rigParameters,parts:['PartUnrelated']},...rigs},
  models:[],loads:[],motionLoads:[],started:[],motions:[],frames:[],statuses:[],errors:[],motionEnds:[],fetches:0,animationFrames:0,clock:0,motionLoad};
  const curveOf=motion=>motion.group!=='App'?curves[motion.group]:
    curves[motionArmPoseByModel.hiyori[motionPresets.find(preset=>preset.group==='App'&&preset.index===motion.index).id]];
  function createInternalModel(rig){
    const core=createCore(rig),pose=createPose(core),hooks=[],manager=new MotionManager(f);
    return {coreModel:core,motionManager:manager,focusController:{focus(){}},width:400,height:800,hooks,
      settings:{getLipSyncParameters:()=>['ParamMouthOpenY'],getEyeBlinkParameters:()=>['ParamEyeLOpen','ParamEyeROpen']},
      on(name,listener){if(name==='beforeModelUpdate')hooks.push(listener);},
      destroy(){manager.destroy();},
      update(dt){
        const motion=manager.update();
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
    // Live2DModel.motion routes to the actual manager's startMotion property.
    motion(group,index,priority){f.motions.push({group,index,priority});return this.internalModel.motionManager.startMotion(group,index,priority);}
    expression(){}
    destroy(options){this.destroyed.push(options);this.internalModel?.destroy();}
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
    playing:()=>{const motion=avatar.model?.internalModel.motionManager.entry?.motion;return motion?{group:motion.group,index:motion.index}:null;},
    // Runs one update and lets its asynchronous SDK Idle request start.
    async warm(){f.tick();await settle();},
    // The same two calls as renderOnce()/tick(), with an explicit SDK time step.
    render(dt=50){avatar.model.update(dt);avatar.app.renderer.render(avatar.app.stage);return f.frames.at(-1);},
    tick(ms=50){f.clock+=ms;avatar.tick(f.clock);return f.frames.at(-1);}});
}

// Stale motion starts at the real startMotion/state seam (shared pending loads).
const appStarts=(f,manager=null)=>f.started.filter(start=>start.group==='App'&&(!manager||start.manager===manager)).map(start=>start.index);
const pendingFor=(pending,preset)=>(group,index)=>group==='App'&&index===preset.index?pending.promise:true;

test('an old and a new request for the same preset share one pending load and only the newest starts',async t=>{
  for(const character of [characters.hiyori,characters.chitose])await t.test(character.name,async child=>{
    const pending=deferred(),f=fixture(child,{motionLoad:pendingFor(pending,raisedPreset)});
    await f.select(character);await f.warm();
    f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));const old=f.avatar.performanceGesture;
    f.avatar.applyPerformance(frame({gesture:raisedPreset.id,inputSeq:2,turnId:'reply-2'}));const current=f.avatar.performanceGesture;
    assert.notEqual(current,old);
    assert.deepEqual(f.motionLoads.filter(key=>key===`App:${raisedPreset.index}`),[`App:${raisedPreset.index}`],'one shared pending load');
    pending.resolve(true);await settle();
    assert.deepEqual(appStarts(f),[raisedPreset.index],'exactly one start');
    assert.equal(f.avatar.performanceGesture,current);assert.ok(Number.isFinite(current.until),'the newest request started');
    assert.deepEqual(f.playing(),{group:'App',index:raisedPreset.index});assert.equal(f.manager().playing,true);assert.deepEqual(f.errors,[]);
    f.avatar.mouth=.4;f.avatar.elapsed+=.3;near(f.render().values.get('ParamMouthOpenY'),.4,'audio still owns the mouth');
  });
});

test('separate old and new presets start only the newest in either completion order',async t=>{
  const first=raisedPreset,second=motionPresets.find(preset=>preset.id==='nod');
  for(const order of ['old first','new first'])await t.test(order,async child=>{
    const loads={[first.index]:deferred(),[second.index]:deferred()};
    const f=fixture(child,{motionLoad:(group,index)=>group==='App'?loads[index].promise:true});
    await f.select(characters.hiyori);await f.warm();
    f.avatar.applyPerformance(frame({gesture:first.id}));
    f.avatar.applyPerformance(frame({gesture:second.id,inputSeq:2,turnId:'reply-2'}));const current=f.avatar.performanceGesture;
    for(const preset of order==='old first'?[first,second]:[second,first]){loads[preset.index].resolve(true);await settle();}
    assert.deepEqual(appStarts(f),[second.index]);assert.equal(f.avatar.performanceGesture,current);assert.ok(Number.isFinite(current.until));
    assert.deepEqual(f.playing(),{group:'App',index:second.index});assert.deepEqual(f.errors,[]);
  });
});

test('an old preview cannot take the reservation of a new performance request for the same preset',async t=>{
  const pending=deferred(),f=fixture(t,{motionLoad:pendingFor(pending,raisedPreset)});
  await f.select(characters.hiyori);await f.warm();
  const opening=f.avatar.playMotion(raisedPreset);
  f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));const current=f.avatar.performanceGesture;
  pending.resolve(true);assert.equal(await opening,false);await settle();
  assert.equal(f.avatar.preview,false);assert.deepEqual(f.motionEnds,['interrupted']);
  assert.deepEqual(appStarts(f),[raisedPreset.index]);assert.equal(f.avatar.performanceGesture,current);assert.ok(Number.isFinite(current.until));
});

test('a delayed SDK Idle start cannot revive Idle after a reset, while an uninterrupted Idle still starts once',async t=>{
  for(const interrupted of [true,false])await t.test(interrupted?'interrupted':'uninterrupted',async child=>{
    const pending=deferred(),f=fixture(child,{motionLoad:group=>group==='Idle'?pending.promise:true});
    await f.select(characters.hiyori);f.tick();
    assert.deepEqual(f.motionLoads,['Idle:0'],'the Idle requests share one pending load');
    if(interrupted)f.avatar.applyPerformance(frame());
    else assert.equal(f.manager().state.reservedIdleGroup,'Idle','the newer Idle request owns the slot');
    const manager=f.manager(),start=manager.state.start;let claims=0;
    // Count state.start calls that reach the real Idle slot: only the current owner may clear it.
    manager.state.start=function(...args){if(args[3]===1)claims++;return start.apply(this,args);};
    pending.resolve(true);await settle();
    assert.equal(claims,interrupted?0:1,'a stale Idle continuation never touches the real Idle reservation');
    const idleStarts=f.started.filter(start=>start.group==='Idle').length;
    assert.equal(idleStarts,interrupted?0:1);assert.equal(f.manager().playing,!interrupted);
    for(let i=0;i<5;i++){
      const rendered=f.tick();await settle();
      if(interrupted)assert.equal(rendered.values.get('ParamArmLB'),0,'no Idle curve in performance mode');
    }
    assert.equal(f.started.filter(start=>start.group==='Idle').length,idleStarts);
  });
});

test('select, release and destroy leave a pending start on the old manager unable to start',async t=>{
  for(const [name,stop]of [['select',f=>f.select(characters.chitose)],['release',f=>f.select(null)],['destroy',f=>f.avatar.destroy()]])await t.test(name,async child=>{
    const pending=deferred(),f=fixture(child,{motionLoad:pendingFor(pending,raisedPreset)});
    await f.select(characters.hiyori);
    f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));const manager=f.manager();
    assert.equal(manager.playing,false,'precondition: nothing is playing');
    await stop(f);pending.resolve(true);await settle();
    assert.deepEqual(appStarts(f,manager),[]);assert.equal(manager.playing,false);assert.deepEqual(f.errors,[]);
    if(f.avatar.model)assert.notEqual(f.manager(),manager);
  });
});

test('a current start writes the actual manager playing flag, and synchronous motionStart re-entry cannot start a replaced motion',async t=>{
  await t.test('finish',async child=>{
    const f=fixture(child);await f.select(characters.hiyori);await f.warm();
    f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));await settle();
    const manager=f.manager();let finishes=0;manager.on('motionFinish',()=>finishes++);
    assert.equal(manager.playing,true);assert.deepEqual(appStarts(f,manager),[raisedPreset.index]);
    manager.entry.finished=true;f.render();f.render();
    assert.equal(finishes,1);assert.equal(manager.playing,false);
  });
  for(const [name,reenter]of [['stop',f=>f.avatar.react('calm')],['release',f=>f.avatar.select(null)],['destroy',f=>f.avatar.destroy()]])await t.test(`re-entry: ${name}`,async child=>{
    const f=fixture(child);await f.select(characters.hiyori);
    const manager=f.manager();let entered=0,finishes=0;
    assert.equal(manager.playing,false,'precondition: nothing is playing');
    manager.on('motionStart',group=>{if(group==='App'&&!entered++)reenter(f);});
    manager.on('motionFinish',()=>finishes++);
    f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));await settle();
    assert.equal(entered,1);assert.deepEqual(appStarts(f,manager),[],'the replaced motion was not started');
    assert.equal(manager.playing,false,'no phantom playing flag');assert.equal(manager.entry,null);
    assert.equal(manager.state.currentGroup,undefined);assert.equal(manager.state.reservedGroup,undefined);
    if(f.avatar.model){
      // The next natural update emits no motionFinish for the motion that never started; Idle may begin.
      f.render();await settle();f.render();
      assert.equal(finishes,0);assert.deepEqual(appStarts(f,manager),[]);
    }
    assert.deepEqual(f.errors,[]);
  });
});

test('a legacy reaction rejection is reported only for the current turn',async t=>{
  for(const [name,listener,errors]of [
    ['stale',f=>{f.avatar.react('calm');throw new Error('listener failure');},0],
    ['current',()=>{throw new Error('listener failure');},1]])await t.test(name,async child=>{
    const f=fixture(child);await f.select(characters.hiyori);await f.warm();
    f.manager().on('motionStart',group=>{if(group==='Tap')listener(f);});
    f.avatar.react('happy');await settle();
    assert.equal(f.errors.length,errors);
  });
});

test('a failed load for the current model still reports motionLoadError and releases the gesture',async t=>{
  const f=fixture(t,{motionLoad:(group,index)=>group==='App'&&index===raisedPreset.index?null:true});
  await f.select(characters.hiyori);await f.warm();
  f.avatar.applyPerformance(frame({gesture:raisedPreset.id}));await settle();
  assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/動作データ/);
  assert.equal(f.avatar.performanceGesture,null);assert.deepEqual(appStarts(f),[]);
});
