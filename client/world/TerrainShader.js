import * as THREE from 'three';

/**
 * Create a terrain shader material for WoW-style texture splatting.
 *
 * Implements WoW's normalized blending formula:
 * finalColor = tex0*(1-(a1+a2+a3)) + tex1*a1 + tex2*a2 + tex3*a3
 *
 * @param {Object} options - Shader configuration
 * @param {THREE.Texture} options.baseTexture - Layer 0 (opaque base)
 * @param {THREE.Texture[]} options.overlayTextures - Layers 1-3 (optional)
 * @param {THREE.DataTexture[]} options.alphaMaps - Alpha maps for overlay layers (64x64)
 * @param {number} options.textureScale - Tiling factor for detail textures (default: 4.0)
 * @param {number} options.alphaSharpening - Power curve for alpha sharpening (default: 2.0)
 * @returns {THREE.ShaderMaterial}
 */
export function createTerrainMaterial(options) {
  const {
    baseTexture,
    overlayTextures = [],
    alphaMaps = [],
    textureScale = 4.0,
    alphaSharpening = 2.0,
  } = options;

  // Ensure we have at most 3 overlay layers
  const numOverlays = Math.min(overlayTextures.length, 3);

  // Build shader based on number of layers
  const uniforms = {
    baseTexture: { value: baseTexture },
    textureScale: { value: textureScale },
    alphaSharpening: { value: alphaSharpening },
  };

  // Add overlay textures and alpha maps
  for (let i = 0; i < 3; i++) {
    if (i < numOverlays) {
      uniforms[`overlayTexture${i + 1}`] = { value: overlayTextures[i] };
      uniforms[`alphaMap${i + 1}`] = { value: alphaMaps[i] };
    } else {
      // Placeholder for unused layers
      uniforms[`overlayTexture${i + 1}`] = { value: null };
      uniforms[`alphaMap${i + 1}`] = { value: null };
    }
  }

  const vertexShader = `
    varying vec2 vUv;
    varying vec3 vWorldPos;

    void main() {
      vUv = uv;
      // Pass world position to fragment shader for continuous texture tiling
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `;

  const fragmentShader = `
    uniform sampler2D baseTexture;
    uniform sampler2D overlayTexture1;
    uniform sampler2D overlayTexture2;
    uniform sampler2D overlayTexture3;
    uniform sampler2D alphaMap1;
    uniform sampler2D alphaMap2;
    uniform sampler2D alphaMap3;
    uniform float textureScale;
    uniform float alphaSharpening;

    varying vec2 vUv;
    varying vec3 vWorldPos;

    void main() {
      // Use chunk-local UVs for texture sampling (like WoW does)
      // This tiles the texture 8 times per chunk
      vec2 tiledUv = vUv * 8.0;

      vec3 color0 = texture2D(baseTexture, tiledUv).rgb;

      // Initialize blending weights
      float a1 = 0.0;
      float a2 = 0.0;
      float a3 = 0.0;

      // Sample overlay textures and alpha maps
      ${numOverlays >= 1 ? `
      vec3 color1 = texture2D(overlayTexture1, tiledUv).rgb;
      a1 = texture2D(alphaMap1, vUv).r;
      a1 = pow(a1, alphaSharpening);
      ` : ''}

      ${numOverlays >= 2 ? `
      vec3 color2 = texture2D(overlayTexture2, tiledUv).rgb;
      a2 = texture2D(alphaMap2, vUv).r;
      a2 = pow(a2, alphaSharpening);
      ` : ''}

      ${numOverlays >= 3 ? `
      vec3 color3 = texture2D(overlayTexture3, tiledUv).rgb;
      a3 = texture2D(alphaMap3, vUv).r;
      a3 = pow(a3, alphaSharpening);
      ` : ''}

      // WoW's normalized blending formula
      float alphaSum = a1 + a2 + a3;
      if (alphaSum > 1.0) {
        float scale = 1.0 / alphaSum;
        a1 *= scale;
        a2 *= scale;
        a3 *= scale;
        alphaSum = 1.0;
      }

      // Base layer gets remaining alpha after overlays
      float a0 = 1.0 - alphaSum;

      // Blend all layers
      vec3 finalColor = color0 * a0;
      ${numOverlays >= 1 ? 'finalColor += color1 * a1;' : ''}
      ${numOverlays >= 2 ? 'finalColor += color2 * a2;' : ''}
      ${numOverlays >= 3 ? 'finalColor += color3 * a3;' : ''}

      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.FrontSide,
  });

  // Store metadata for debugging
  material.userData = {
    numLayers: numOverlays + 1,
    textureScale,
    alphaSharpening,
  };

  return material;
}

/**
 * Create a DataTexture from base64-encoded alpha map data.
 *
 * @param {string} base64Data - Base64-encoded 64x64 alpha map
 * @returns {THREE.DataTexture}
 */
export function createAlphaTexture(base64Data) {
  // Decode base64 to Uint8Array
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Create DataTexture (64x64, R format)
  const texture = new THREE.DataTexture(
    bytes,
    64, // width
    64, // height
    THREE.RedFormat,
    THREE.UnsignedByteType
  );

  // Use linear filtering for smooth upscaling (WoW uses bicubic, but linear is close)
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = false; // DataTexture: don't flip (data is already in correct orientation)
  texture.needsUpdate = true;

  return texture;
}

/**
 * Load a terrain texture from the terrain/textures directory.
 *
 * @param {string} webpFilename - WebP filename (e.g., "elwynn_grass.webp")
 * @returns {Promise<THREE.Texture>}
 */
export function loadTerrainTexture(webpFilename) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    const path = `/assets/terrain/textures/${webpFilename}`;

    loader.load(
      path,
      (texture) => {
        // Configure texture for tiling detail textures
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = 16; // Maximum anisotropic filtering for quality
        texture.needsUpdate = true;
        resolve(texture);
      },
      undefined,
      (error) => {
        console.error(`Failed to load texture: ${path}`, error);
        reject(error);
      }
    );
  });
}
