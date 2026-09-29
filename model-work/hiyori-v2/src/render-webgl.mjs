// WebGL1 renderer for the same frame list as render-canvas2d.mjs.
// Premultiplied alpha; eyeball masks via the stencil buffer; the cuff clip
// plane is evaluated per fragment in model space. No seams: triangles share
// exact edges, as in the Cubism renderer.

const VS = `
attribute vec2 aPos; attribute vec2 aUv;
uniform vec2 uScale; uniform vec2 uOffset;
varying vec2 vUv; varying vec2 vPos;
void main(){ vUv = vec2(aUv.x, 1.0 - aUv.y); vPos = aPos; gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0); }`;
const FS = `
precision mediump float;
uniform sampler2D uTex; uniform float uOpacity; uniform vec3 uClip; uniform float uUseClip; uniform float uMaskPass;
varying vec2 vUv; varying vec2 vPos;
void main(){
  if (uUseClip > 0.5 && dot(uClip.xy, vPos) + uClip.z < 0.0) discard;
  vec4 c = texture2D(uTex, vUv);
  if (uMaskPass > 0.5 && c.a < 0.1) discard;
  gl_FragColor = c * uOpacity;
}`;

export class WebGLFrameRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl', {premultipliedAlpha: true, alpha: true, stencil: true, antialias: true});
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl; this.canvas = canvas;
    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.program = p;
    this.loc = Object.fromEntries(['aPos', 'aUv'].map(n => [n, gl.getAttribLocation(p, n)]));
    this.uni = Object.fromEntries(['uScale', 'uOffset', 'uTex', 'uOpacity', 'uClip', 'uUseClip', 'uMaskPass'].map(n => [n, gl.getUniformLocation(p, n)]));
    this.posBuffer = gl.createBuffer();
    this.static = new WeakMap(); // uvs/indices typed array -> GL buffer
    this.textures = [];
  }

  setTextures(images) {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures = images.map(image => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      const pot = (image.width & (image.width - 1)) === 0 && (image.height & (image.height - 1)) === 0;
      if (pot) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, pot ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    });
  }

  buffer(array, target) {
    let b = this.static.get(array);
    if (!b) {
      const gl = this.gl;
      const data = target === gl.ELEMENT_ARRAY_BUFFER && !(array instanceof Uint16Array) ? Uint16Array.from(array)
        : target === gl.ARRAY_BUFFER && !(array instanceof Float32Array) ? Float32Array.from(array) : array;
      b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW);
      this.static.set(array, b);
    }
    return b;
  }

  drawItem(item, mask = false) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, item.positions, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(this.loc.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer(item.uvs, gl.ARRAY_BUFFER));
    gl.vertexAttribPointer(this.loc.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[item.texture]);
    gl.uniform1f(this.uni.uOpacity, mask ? 1 : item.opacity);
    gl.uniform1f(this.uni.uMaskPass, mask ? 1 : 0);
    if (item.clipPlane && !mask) { gl.uniform3fv(this.uni.uClip, item.clipPlane); gl.uniform1f(this.uni.uUseClip, 1); } else gl.uniform1f(this.uni.uUseClip, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffer(item.indices, gl.ELEMENT_ARRAY_BUFFER));
    gl.drawElements(gl.TRIANGLES, item.indices.length, gl.UNSIGNED_SHORT, 0);
  }

  // view: {scale (px per unit), originX, originY} in CSS px of the canvas' drawing buffer.
  render(frame, view, background = null) {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    if (background) gl.clearColor(background[0] * background[3], background[1] * background[3], background[2] * background[3], background[3]);
    else gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.enableVertexAttribArray(this.loc.aPos); gl.enableVertexAttribArray(this.loc.aUv);
    gl.uniform2f(this.uni.uScale, 2 * view.scale / w, 2 * view.scale / h);
    gl.uniform2f(this.uni.uOffset, 2 * view.originX / w - 1, 1 - 2 * view.originY / h);
    gl.uniform1i(this.uni.uTex, 0); gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    for (const item of frame) {
      if (item.opacity <= 0.001 || !item.indices.length) continue;
      if (item.masks?.length) {
        gl.enable(gl.STENCIL_TEST);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        for (const mask of item.masks) this.drawItem(mask, true);
        gl.colorMask(true, true, true, true);
        gl.stencilFunc(gl.EQUAL, 1, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        this.drawItem(item);
        gl.disable(gl.STENCIL_TEST);
      } else {
        this.drawItem(item);
      }
    }
  }

  destroy() {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures = [];
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
