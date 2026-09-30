// The renderer owns model lifetime, animation time, and the audio-to-mouth bridge.
// Core and model files are local assets; no model data is sent to an API.
import {motionPresets,motionParameterIdsByModel,motionArmPoseByModel} from './motion-presets.mjs';
import {performanceGestures} from './performance-catalog.mjs';
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const normalized=id=>id.replace(/_/g,'').toLowerCase();
const smooth=value=>{const t=clamp(value,0,1);return t*t*(3-2*t);};
const aliases=['ParamAngleX','ParamAngleY','ParamAngleZ','ParamEyeBallX','ParamEyeBallY','ParamBodyAngleX','ParamBreath'];
const expressionNames={calm:'Normal.exp3.json',happy:'Smile.exp3.json',concerned:'Sad.exp3.json',focused:'Normal.exp3.json',dizzy:'Normal.exp3.json',surprised:'Surprised.exp3.json'};
const faces={
  calm:{smile:0,brow:0,browAngle:0,eye:1,tilt:0},
  happy:{smile:1,brow:.25,browAngle:0,eye:.75,tilt:4},
  concerned:{smile:-.65,brow:.45,browAngle:-.7,eye:.83,tilt:-7},
  focused:{smile:-.2,brow:-.25,browAngle:.4,eye:.7,tilt:0},
  dizzy:{smile:-.45,brow:.15,browAngle:-.3,eye:.5,tilt:0},
  surprised:{smile:0,brow:.7,browAngle:0,eye:1.15,tilt:-3}
};
const performanceStates=new Set(['disconnected','waiting','listening','speaking','awaiting_response','considering','unknown']);

async function loadModel(PIXI,url){
  const options={autoUpdate:false,autoInteract:false,motionPreload:'ALL'};
  // from() hides the instance if setup rejects, although its Core may exist already.
  const model=new PIXI.live2d.Live2DModel(options),textures=new Set(),textureTasks=[];
  model.once('settingsLoaded',settings=>{
    for(const file of settings.textures){
      const textureURL=settings.resolveURL(file);
      // The factory uses the same cached textures. Keep failed/partially loaded
      // textures too: it assigns model.textures only after every image succeeds.
      textures.add(PIXI.Texture.from(textureURL,{resourceOptions:{autoLoad:false}},false));
      textureTasks.push(PIXI.Texture.fromURL(textureURL).catch(()=>{}));
    }
  });
  try{
    await PIXI.live2d.Live2DFactory.setupLive2DModel(model,url,options);
    return model;
  }catch(error){
    // Do not destroy an image while another factory continuation still uses it,
    // or let the next selection acquire a texture that this load will destroy.
    await Promise.allSettled(textureTasks);
    for(const texture of model.textures)textures.add(texture);
    if(model.internalModel)model.destroy({children:true});
    else{
      // v0.4.0's model.destroy() requires an initialized internalModel.
      model.emit('destroy');model.autoUpdate=false;model.unregisterInteraction();
      PIXI.Container.prototype.destroy.call(model,{children:true});
    }
    for(const texture of textures)texture.destroy(true);
    throw error;
  }
}

export class Live2DAvatar {
  constructor({canvas,onError=()=>{},onStatus=()=>{},onMotionEnd=()=>{},now=()=>performance.now()}){
    this.canvas=canvas;this.onError=onError;this.onStatus=onStatus;this.onMotionEnd=onMotionEnd;
    this.now=now;this.performanceFrame=null;this.performanceGesture=null;this.performanceTurnKeys=new Set();this.performanceHeadAt=0;
    this.performanceRelease=null;this.lastPerformancePose=null;this.armPose=null;this.armRig=null;
    this.generation=0;this.action=0;this.active=true;this.reduced=false;this.disposed=false;
    this.reaction='calm';this.face={...faces.calm};this.audio=0;this.mouth=0;this.elapsed=0;
    this.frame=0;this.lastTime=0;this.model=null;this.app=null;this.preview=false;this.previewUntil=Infinity;
    this.tick=this.tick.bind(this);
  }

  initialize(){
    if(this.app)return;
    const PIXI=globalThis.PIXI;
    if(!PIXI?.live2d?.Live2DModel||!globalThis.Live2DCubismCore)throw new Error('Live2Dの再生ライブラリを読み込めません。ページを再読込してください。');
    PIXI.live2d.config.sound=false;
    this.app=new PIXI.Application({view:this.canvas,width:210,height:350,backgroundAlpha:0,antialias:true,resolution:Math.min(devicePixelRatio||1,2),autoDensity:true,autoStart:false,sharedTicker:false});
    this.app.stop();
    // All interaction is handled by the accessible HTML button, not a second Pixi ticker.
    if(this.app.renderer.plugins.interaction)this.app.renderer.plugins.interaction.useSystemTicker=false;
  }

  async select(character){
    const generation=++this.generation;++this.action;
    this.stopPreview('interrupted');this.stopFrame();this.releaseModel();this.audio=0;this.mouth=0;this.reaction='calm';this.face={...faces.calm};
    this.performanceFrame=null;this.performanceGesture=null;this.performanceRelease=null;this.lastPerformancePose=null;this.performanceTurnKeys.clear();
    if(!character||this.disposed){this.onStatus('empty','');return;}
    this.onStatus('loading',`${character.name}を読み込み中…`);
    // Serialize loads because Pixi caches textures by URL. A stale load must be
    // destroyed before a newer load can acquire the same cached texture.
    const previous=this.pendingLoad;let finish;
    this.pendingLoad=new Promise(resolve=>{finish=resolve;});
    if(previous)await previous;
    if(generation!==this.generation||this.disposed){finish();return;}
    let loaded;
    try{
      this.initialize();
      loaded=await loadModel(globalThis.PIXI,character.modelURL);
      if(generation!==this.generation||this.disposed){loaded.destroy({children:true,texture:true,baseTexture:true});return;}
      this.model=loaded;this.character=character;this.elapsed=0;
      // Before the first model update, which may request SDK Idle.
      this.guardMotionStarts(loaded);
      const internal=loaded.internalModel,core=internal.coreModel,parameters=core.getModel().parameters;
      this.parameters=new Map(Array.from(parameters.ids,(id,index)=>[normalized(id),{id,index,min:parameters.minimumValues[index],max:parameters.maximumValues[index],default:parameters.defaultValues[index]}]));
      // Chitose uses PARAM_* IDs. Never ask Cubism to create nonexistent parameters.
      for(const name of aliases){const parameter=this.parameters.get(normalized(name));if(parameter)internal[`id${name}`]=parameter.id;}
      const breath=internal.breath;
      if(breath)breath.setParameters(breath.getParameters().map(parameter=>({...parameter,parameterId:this.parameters.get(normalized(parameter.parameterId))?.id||parameter.parameterId})));
      this.originalBreath=breath;
      this.originalPhysics=internal.physics;
      this.lipIds=internal.settings.getLipSyncParameters()||[];
      if(!this.lipIds.length){const mouth=this.parameters.get(normalized('ParamMouthOpenY'));if(mouth)this.lipIds=[mouth.id];}
      this.eyeIds=internal.settings.getEyeBlinkParameters()||[];
      internal.on('beforeModelUpdate',()=>this.applyFace());
      const reportLoadError=message=>{if(generation===this.generation&&loaded===this.model&&!this.disposed)this.onError(new Error(message));};
      internal.motionManager.on('motionLoadError',()=>reportLoadError('モデルの動作データを読み込めません。ページを再読込してください。'));
      internal.motionManager.expressionManager?.on('expressionLoadError',()=>reportLoadError('モデルの表情データを読み込めません。ページを再読込してください。'));
      loaded.anchor.set(.5,1);
      this.app.stage.addChild(loaded);
      this.setReducedMotion(this.reduced);
      this.resize();
      this.onStatus('ready','');
      if(this.performanceFrame)this.applyPerformance(this.performanceFrame);else this.react(this.reaction);
      this.syncFrame();
    }catch(error){
      if(generation!==this.generation||this.disposed)return;
      this.releaseModel();
      this.onStatus('error','モデルを読み込めません。再選択すると再試行します。');
      this.onError(new Error(`Live2Dの読み込みに失敗しました。${error?.message||''}`));
    }finally{finish();}
  }

  resize(){
    if(!this.app)return;
    const parent=this.canvas.parentElement;
    const width=parent.clientWidth||210,height=parent.clientHeight||350;
    this.app.renderer.resize(width,height);
    if(this.model){
      const internal=this.model.internalModel;
      const scale=Math.min((width-8)/internal.width,(height-4)/internal.height);
      this.model.scale.set(scale);this.model.position.set(width/2,height-2);
      this.renderOnce();
    }
  }

  react(reaction){
    if(!Object.hasOwn(faces,reaction))return;
    if(this.performanceFrame){this.stopPerformanceGesture({immediate:true});this.performanceFrame=null;this.performanceTurnKeys.clear();if(this.model)this.model.internalModel.motionManager.groups.idle=this.reduced?'__disabled__':'Idle';}
    this.stopPreview('interrupted');
    this.reaction=reaction;
    const model=this.model,action=++this.action;
    if(!model)return;
    const manager=model.internalModel.motionManager;
    // v0.4.0 returns early when the requested expression is already current;
    // invalidate a different pending expression before that early return.
    if(manager.expressionManager)manager.expressionManager.reserveExpressionIndex=-1;
    manager.stopAllMotions();
    // A new reaction invalidates a pending gesture, including a previous character.
    const gesture=!this.reduced&&this.active&&reaction==='happy'?(this.character.name==='チトセ'?'Flick':'Tap'):null;
    const motion=gesture?model.motion(gesture,0,3):Promise.resolve();
    Promise.resolve(motion).then(()=>{
      if(action!==this.action||model!==this.model||this.disposed)return;
      const expression=expressionNames[reaction];
      if(manager.expressionManager?.definitions.some(item=>item.Name===expression))return model.expression(expression);
    }).catch(()=>{if(action===this.action&&model===this.model&&!this.disposed)this.onError(new Error('Live2Dの反応を再生できません。'));});
  }

  // pixi-live2d-display 0.4.0 shares one pending load per group/index and reads
  // manager.state again after it. Without this guard, a continuation from before
  // stopAllMotions() can consume a newer reservation for the same pair (or the
  // Idle slot), start an obsolete motion and make the newer request fail. Each
  // call runs with a facade whose state rejects a stale call before touching the
  // real state; loads, events and property writes still use the actual manager.
  guardMotionStarts(model){
    const manager=model.internalModel.motionManager,state=manager.state,startMotion=manager.startMotion,reset=state.reset;
    let resets=0;
    state.reset=function(...args){++resets;return reset.apply(this,args);};
    manager.startMotion=(group,index,priority)=>{
      const ticket={resets,generation:this.generation,action:this.action};
      // SDK Idle (priority 1) is not an avatar action; only a reset or a model change makes it stale.
      const current=()=>ticket.resets===resets&&ticket.generation===this.generation&&model===this.model&&!this.disposed&&
        (priority===1||ticket.action===this.action);
      const guardedState=new Proxy(state,{get(target,key){
        const value=Reflect.get(target,key,target);
        if(typeof value!=='function')return value;
        return key==='reserve'||key==='start'?(...args)=>current()&&value.apply(target,args):value.bind(target);
      }});
      const facade=new Proxy(manager,{
        get(target,key){
          if(key==='state')return guardedState;
          // A motionStart listener may stop, release or replace this motion synchronously.
          if(key==='_startMotion')return motion=>current()?target._startMotion(motion):undefined;
          const value=Reflect.get(target,key,target);
          return typeof value==='function'?value.bind(target):value;
        },
        set(target,key,value){return key==='playing'&&value&&!current()?true:Reflect.set(target,key,value,target);},
      });
      return startMotion.call(facade,group,index,priority);
    };
  }

  // A frame changes independent layers. It deliberately does not call react(),
  // whose legacy happy reaction starts a Tap motion and stops existing motions.
  applyPerformance(frame){
    if(this.disposed||!frame||!performanceStates.has(frame.state)||!Object.hasOwn(faces,frame.expression)||
      !Object.hasOwn(performanceGestures,frame.gesture)||!['still','nod','tilt'].includes(frame.head)||!['forward','away'].includes(frame.gaze)||
      !Number.isFinite(frame.intensity)||frame.intensity<0||frame.intensity>1||
      !Number.isSafeInteger(frame.epoch)||frame.epoch<0||!Number.isSafeInteger(frame.inputSeq)||frame.inputSeq<0||
      frame.expiresAt!==null&&(!Number.isFinite(frame.expiresAt)||frame.expiresAt<=this.now()))return false;
    const previous=this.performanceFrame;
    if(previous&&(frame.epoch<previous.epoch||frame.epoch===previous.epoch&&frame.inputSeq<previous.inputSeq))return false;
    const newIdentity=!previous||previous.epoch!==frame.epoch||previous.inputSeq!==frame.inputSeq;
    const suppress=frame.state==='listening'||frame.state==='disconnected'||frame.reducedMotion===true||frame.paused===true||this.reduced||!this.active;
    if(!previous||newIdentity||suppress||frame.expiresAt===null){
      ++this.action;this.stopPreview('interrupted');this.stopPerformanceGesture({immediate:frame.state==='disconnected'||frame.reducedMotion===true||frame.paused===true||this.reduced||!this.active});
      const manager=this.model?.internalModel.motionManager;
      if(!previous&&manager){
        manager.stopAllMotions();
        if(manager.expressionManager){manager.expressionManager.reserveExpressionIndex=-1;manager.expressionManager.resetExpression();}
        // A sparse App gesture must begin from the rig's neutral values, not
        // the last saved legacy Idle/Tap pose on channels it does not own.
        const core=this.model.internalModel.coreModel;
        for(const parameter of this.parameters.values())core.setParameterValueById(parameter.id,parameter.default);
        core.saveParameters();
      }
    }
    if(!previous||previous.epoch!==frame.epoch)this.performanceTurnKeys.clear();
    if(newIdentity||previous.head!==frame.head)this.performanceHeadAt=this.elapsed;
    this.performanceFrame={...frame};this.reaction=frame.expression;
    const model=this.model;if(!model)return true;
    this.applyArmPose();
    model.internalModel.motionManager.groups.idle='__disabled__';
    model.internalModel.focusController.focus(0,0,true);
    const turnKey=typeof frame.turnId==='string'?`${frame.epoch}:${frame.turnId}`:`${frame.epoch}:${frame.inputSeq}`;
    if(frame.gesture!=='none'&&!this.performanceTurnKeys.has(turnKey)){
      this.performanceTurnKeys.add(turnKey);
      if(this.performanceTurnKeys.size>256)this.performanceTurnKeys.delete(this.performanceTurnKeys.values().next().value);
      const preset=motionPresets.find(item=>item.id===performanceGestures[frame.gesture]);
      if(!suppress&&preset&&model.internalModel.motionManager.definitions[preset.group]?.[preset.index]){
        this.stopPerformanceGesture();const action=++this.action;
        // A sparse motion owns only the current rig's authored channels. A
        // different character's curves must not suppress this rig's expression.
        const modelParameters=motionParameterIdsByModel[this.character?.id];
        const parameters=new Set((modelParameters?.[preset.id]||[]).map(normalized));
        const gesture={action,model,parameters,until:Infinity};this.performanceGesture=gesture;
        Promise.resolve(model.motion(preset.group,preset.index,3)).then(started=>{
          if(action!==this.action||model!==this.model||this.disposed||this.performanceGesture!==gesture)return;
          if(!started){this.stopPerformanceGesture();return;}
          gesture.until=this.elapsed+preset.duration+.2;
          this.startArmPose(preset,model);
        }).catch(()=>{if(action===this.action&&model===this.model&&!this.disposed){this.stopPerformanceGesture();this.onError(new Error('Live2Dの演技を再生できません。'));}});
      }
    }
    return true;
  }

  stopPerformanceGesture({immediate=false}={}){
    const gesture=this.performanceGesture;
    if(!gesture&&!immediate)return;
    ++this.action;this.performanceGesture=null;
    this.resetArmPose();
    if(immediate){this.performanceRelease=null;this.lastPerformancePose=null;}
    if(!this.model)return;
    const internal=this.model.internalModel,core=internal.coreModel;
    internal.motionManager.stopAllMotions();
    const from=new Map();
    for(const [name,parameter]of this.parameters){
      if(!immediate&&!gesture.parameters.has(name))continue;
      if(!immediate&&!this.lipIds.includes(parameter.id))from.set(name,this.lastPerformancePose?.get(name)??core.getParameterValueById(parameter.id));
      core.setParameterValueById(parameter.id,parameter.default);
    }
    // Clear the native motion's saved pose immediately. Its visible pose eases
    // separately, so the transition cannot accumulate in Cubism's next update.
    core.saveParameters();
    if(!immediate&&from.size)this.performanceRelease={model:this.model,from,at:this.elapsed,duration:.28};
  }

  async playMotion(preset){
    const model=this.model;
    if(!model||!this.active||this.reduced||this.disposed)return false;
    if(this.performanceFrame){this.stopPerformanceGesture({immediate:true});this.performanceFrame=null;this.performanceTurnKeys.clear();model.internalModel.motionManager.groups.idle='Idle';}
    const action=++this.action,internal=model.internalModel,manager=internal.motionManager;
    if(!manager.definitions[preset.group]?.[preset.index])return false;
    this.resetArmPose();
    manager.stopAllMotions();
    if(manager.expressionManager){manager.expressionManager.reserveExpressionIndex=-1;manager.expressionManager.resetExpression();}
    internal.breath=undefined;internal.focusController.focus(0,0,true);
    this.preview=true;this.previewUntil=Infinity;
    try{
      const started=await model.motion(preset.group,preset.index,3);
      if(action!==this.action||model!==this.model||this.disposed||!this.preview)return false;
      if(!started){this.stopPreview('interrupted');return false;}
      this.previewUntil=this.elapsed+preset.duration+.2;
      this.startArmPose(preset,model);
      return true;
    }catch{
      if(action===this.action)this.stopPreview('interrupted');
      return false;
    }
  }

  stopPreview(reason){
    if(!this.preview)return;
    ++this.action;this.preview=false;this.previewUntil=Infinity;this.resetArmPose();
    if(this.model){
      const internal=this.model.internalModel,core=internal.coreModel;
      internal.breath=this.reduced?undefined:this.originalBreath;
      internal.motionManager.stopAllMotions();
      // Interrupted curves otherwise leave their saved values (e.g. blush) behind.
      for(const parameter of this.parameters.values())core.setParameterValueById(parameter.id,parameter.default);
      core.saveParameters();
    }
    this.onMotionEnd(reason);
  }

  // Hiyori's raised arms are a separate, mutually exclusive drawing. Cubism's
  // pose selector uses synthetic PartArm parameters, which saveParameters()
  // does not save or restore. Only this verified rig and generated metadata may
  // switch those drawings; performance/API frames never supply part IDs.
  getArmRig(model=this.model){
    if(!model||model!==this.model||this.character?.id!=='hiyori')return null;
    if(this.armRig?.model===model)return this.armRig;
    const core=model.internalModel.coreModel,parts=core.getModel?.()?.parts;
    if(!parts?.ids||!parts.opacities)return null;
    const normal=Array.prototype.indexOf.call(parts.ids,'PartArmA'),raised=Array.prototype.indexOf.call(parts.ids,'PartArmB');
    if(normal<0||raised<0||parts.opacities.length<=Math.max(normal,raised))return null;
    this.armRig={model,core,parts,normal,raised};
    return this.armRig;
  }

  writeArmPose(rig,mix){
    // The SDK pose implementation chooses the first selector above zero; never
    // crossfade the selectors themselves. Blend only the real part opacities.
    const raised=mix>0;
    rig.core.setParameterValueById('PartArmA',raised?0:1);
    rig.core.setParameterValueById('PartArmB',raised?1:0);
    rig.parts.opacities[rig.normal]=1-mix;
    rig.parts.opacities[rig.raised]=mix;
  }

  startArmPose(preset,model){
    const mode=motionArmPoseByModel[this.character?.id]?.[preset.id];
    if(model!==this.model||!['normal','raised'].includes(mode))return;
    const rig=this.getArmRig(model);if(!rig)return;
    this.armPose={rig,mode,at:this.elapsed,end:this.elapsed+preset.duration};
    this.writeArmPose(rig,0);
  }

  applyArmPose(){
    const pose=this.armPose;
    if(!pose){
      // A completed legacy Tap/Idle may have left its synthetic B selector set.
      // Performance mode disables those motions and owns the neutral arm pose
      // between gestures. Legacy react()/Idle keep their original pose policy.
      const rig=this.performanceFrame?this.getArmRig():null;if(rig)this.writeArmPose(rig,0);
      return;
    }
    if(pose.rig.model!==this.model||!this.active||this.reduced||this.disposed){this.resetArmPose();return;}
    // The hook runs after the SDK pose update, so its fade cannot overwrite our
    // bounded blend. Return before the motion finishes; all interruptions reset
    // both selectors and opacities synchronously without waiting for a frame.
    const fade=.18;
    const mix=pose.mode==='raised'?Math.min(smooth((this.elapsed-pose.at)/fade),smooth((pose.end-this.elapsed)/fade)):0;
    this.writeArmPose(pose.rig,mix);
  }

  resetArmPose(){
    const pose=this.armPose;this.armPose=null;
    const rig=pose?.rig||(this.performanceFrame?this.getArmRig():null);
    if(rig)this.writeArmPose(rig,0);
  }

  setAudioLevel(value){this.audio=Number.isFinite(value)?clamp(value,0,1):0;}
  lookAt(x,y){
    if(!this.model||!this.active||this.reduced||this.preview||this.performanceFrame)return;
    this.model.internalModel.focusController.focus(clamp(x,-1,1)*.35,clamp(y,-1,1)*.25);
  }

  setReducedMotion(value){
    this.stopPreview('interrupted');
    this.reduced=!!value;
    if(this.reduced){++this.action;this.stopPerformanceGesture({immediate:true});}
    const internal=this.model?.internalModel;if(!internal)return;
    internal.motionManager.stopAllMotions();
    internal.motionManager.groups.idle=this.reduced||this.performanceFrame?'__disabled__':'Idle';
    internal.breath=this.reduced?undefined:this.originalBreath;
    internal.physics=this.reduced?undefined:this.originalPhysics;
    internal.focusController.focus(0,0,true);
    if(this.reduced){
      const core=internal.coreModel;
      for(const parameter of this.parameters.values())core.setParameterValueById(parameter.id,parameter.default);
      core.saveParameters();
    }
  }

  setActive(value){
    this.active=!!value;
    if(!this.active)this.stopPerformanceGesture({immediate:true});
    if(!this.active){++this.action;this.stopPreview('interrupted');this.audio=0;this.mouth=0;const manager=this.model?.internalModel.motionManager;if(manager?.expressionManager)manager.expressionManager.reserveExpressionIndex=-1;manager?.stopAllMotions();this.stopFrame();this.renderOnce();}
    else this.syncFrame();
  }

  applyFace(){
    const internal=this.model?.internalModel;if(!internal)return;
    const core=internal.coreModel;
    const set=(name,value)=>{
      const parameter=this.parameters.get(normalized(name));
      if(parameter)core.setParameterValueById(parameter.id,clamp(value,parameter.min,parameter.max));
    };
    const add=(name,value)=>{
      const parameter=this.parameters.get(normalized(name));
      if(parameter)set(name,core.getParameterValueById(parameter.id)+value);
    };
    // The hook runs after motions, expressions, and physics, but before the mesh update.
    for(const id of this.lipIds)set(id,this.active?this.mouth:0);
    this.applyArmPose();
    if(this.preview)return;
    const performanceFrame=this.performanceFrame;
    const quiet=performanceFrame&&(performanceFrame.state==='listening'||performanceFrame.state==='disconnected'||performanceFrame.paused||performanceFrame.reducedMotion||this.reduced);
    const authored=new Map();
    if(performanceFrame&&this.performanceGesture&&!quiet){
      for(const name of this.performanceGesture.parameters){
        const parameter=this.parameters.get(name);
        if(!parameter||this.lipIds.includes(parameter.id))continue;
        const value=core.getParameterValueById(parameter.id);authored.set(name,value);
        set(parameter.id,parameter.default+(value-parameter.default)*performanceFrame.intensity);
      }
    }
    const express=(name,value)=>{
      const authoredValue=authored.get(normalized(name));
      set(name,authoredValue===undefined?value:value+(authoredValue-value)*performanceFrame.intensity);
    };
    express('ParamMouthForm',this.face.smile);
    for(const id of this.eyeIds){
      const parameter=this.parameters.get(normalized(id));
      if(parameter)express(id,(authored.has(normalized(id))?parameter.default:core.getParameterValueById(id))*this.face.eye);
    }
    for(const side of ['L','R']){express(`ParamBrow${side}Y`,this.face.brow);express(`ParamBrow${side}Angle`,this.face.browAngle);}
    if(performanceFrame){
      const intensity=quiet?0:performanceFrame.intensity;
      express('ParamEyeBallX',performanceFrame.gaze==='away'?intensity*.3:0);express('ParamEyeBallY',0);
      // Authored motion owns the whole head gesture. Adding another nod/tilt
      // here would double its pose and can exceed the intended model range.
      if(!quiet&&!this.performanceGesture&&performanceFrame.head==='tilt')add('ParamAngleZ',intensity*6);
      if(!quiet&&!this.performanceGesture&&performanceFrame.head==='nod')add('ParamAngleY',-Math.sin(clamp((this.elapsed-this.performanceHeadAt)/1.1,0,1)*Math.PI)*intensity*5);
    }else if(!this.reduced){
      add('ParamAngleZ',this.face.tilt);
      if(this.reaction==='dizzy'){add('ParamAngleZ',Math.sin(this.elapsed*5)*9);add('ParamAngleX',Math.sin(this.elapsed*3.5)*10);set('ParamEyeBallX',Math.sin(this.elapsed*4)*.55);}
    }
    const release=this.performanceRelease;
    if(release){
      const mix=smooth((this.elapsed-release.at)/release.duration);
      if(release.model!==this.model||mix>=1)this.performanceRelease=null;
      else for(const [name,value]of release.from){
        const parameter=this.parameters.get(name);
        if(parameter&&!this.lipIds.includes(parameter.id))set(parameter.id,value+(core.getParameterValueById(parameter.id)-value)*mix);
      }
    }
    // SDK restores its saved motion parameters after drawing. Capture this
    // post-composition pose for interruption continuity, not that saved pose.
    if(performanceFrame)this.lastPerformancePose=new Map(Array.from(this.parameters,([name,p])=>[name,core.getParameterValueById(p.id)]));
  }

  tick(now){
    this.frame=0;
    if(!this.active||!this.model||this.disposed)return;
    const dt=this.lastTime?Math.min(now-this.lastTime,50):16.67;this.lastTime=now;this.elapsed+=dt/1000;
    if(this.performanceFrame?.expiresAt!==null&&this.performanceFrame&&this.now()>=this.performanceFrame.expiresAt){
      ++this.action;this.stopPerformanceGesture();this.performanceFrame={...this.performanceFrame,expression:'calm',gesture:'none',head:'still',gaze:'forward',intensity:.2,expiresAt:null};this.reaction='calm';
    }
    if(this.performanceGesture&&this.elapsed>=this.performanceGesture.until)this.stopPerformanceGesture();
    const faceBlend=1-Math.exp(-dt/140),mouthBlend=1-Math.exp(-dt/55);
    const target={...faces[this.reaction]};
    if(this.performanceFrame){
      const frame=this.performanceFrame,quiet=frame.state==='listening'||frame.state==='disconnected'||frame.paused;
      const intensity=quiet ? .2 : frame.intensity;
      for(const key of Object.keys(target))target[key]=key==='tilt'?0:faces.calm[key]+(target[key]-faces.calm[key])*intensity;
    }
    for(const key of Object.keys(this.face))this.face[key]+=(target[key]-this.face[key])*faceBlend;
    const mouthTarget=this.audio>.008?clamp((this.audio-.008)*14,0,1):0;
    this.mouth+=(mouthTarget-this.mouth)*mouthBlend;
    this.model.update(dt);this.app.renderer.render(this.app.stage);
    if(this.preview&&this.elapsed>=this.previewUntil)this.stopPreview('complete');
    this.frame=requestAnimationFrame(this.tick);
  }

  renderOnce(){
    if(!this.app||!this.model)return;
    this.model.update(.01);this.app.renderer.render(this.app.stage);
  }
  syncFrame(){if(this.active&&this.model&&!this.frame&&!this.disposed){this.lastTime=0;this.frame=requestAnimationFrame(this.tick);}}
  stopFrame(){if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;this.lastTime=0;}
  releaseModel(){
    this.resetArmPose();this.armRig=null;
    this.performanceGesture=null;this.performanceRelease=null;this.lastPerformancePose=null;
    if(!this.model)return;
    const model=this.model;this.model=null;
    this.app.stage.removeChild(model);model.destroy({children:true,texture:true,baseTexture:true});
    this.app.renderer.clear();
  }
  destroy(){
    if(this.destroyPromise)return this.destroyPromise;
    // A stale factory still owns cached textures until select's finally runs.
    // Stop rendering now, but let callers await that ownership release before
    // constructing another avatar with the same model URL.
    this.destroyPromise=Promise.resolve(this.pendingLoad).then(()=>undefined);
    this.disposed=true;++this.generation;++this.action;this.stopFrame();this.releaseModel();
    if(this.app){this.app.destroy(false,{children:true});this.app=null;}
    return this.destroyPromise;
  }
}
