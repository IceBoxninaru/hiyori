export const characters=Object.freeze({
  hiyori:{id:'hiyori',name:'桃瀬ひより',label:'女性',artist:'Live2D Inc.',source:'https://www.live2d.com/learn/sample/momose-hiyori/',modelURL:'/live2d/hiyori/hiyori.app.model3.json'},
  chitose:{id:'chitose',name:'チトセ',label:'男性',artist:'Live2D Inc.',source:'https://www.live2d.com/learn/sample/chitose/',modelURL:'/live2d/chitose/chitose.app.model3.json'},
  mimo:{name:'mimo',label:'マスコット',artist:null}
});
const reactions=['calm','happy','concerned','focused','dizzy','surprised'];
export const spriteFrames=Object.freeze([...reactions,'blink',...reactions.map(reaction=>`talk-${reaction}`)]);
export const spriteAssets=Object.freeze(['codel','mustafa'].flatMap(id=>spriteFrames.map(frame=>`/characters/${id}/${frame}.png`)));
