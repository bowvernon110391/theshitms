import * as THREE from 'three';

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uBottom;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uSunSize;
  uniform float uSunStrength;
  varying vec3 vDir;

  void main() {
    vec3 dir = normalize(vDir);

    // Vertical gradient, biased so the horizon band stays tight.
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    float t = pow(h, 0.85);
    vec3 col = mix(uBottom, uTop, t);

    // Warm bloom hugging the horizon where the sun is.
    float horizon = 1.0 - smoothstep(0.0, 0.35, abs(dir.y));
    float align = max(dot(dir, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(align, 3.0) * horizon * 0.55 * uSunStrength;

    // The sun disc itself.
    float disc = smoothstep(uSunSize, uSunSize * 0.72, distance(dir, normalize(uSunDir)));
    col += uSunColor * disc * uSunStrength * 2.2;

    // Gentle ground fade so the dome meets the grass without a seam.
    col = mix(col * 0.55, col, smoothstep(-0.18, 0.02, dir.y));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Sky {
  constructor(radius = 460) {
    this.uniforms = {
      uTop: { value: new THREE.Color(0x2f6fd0) },
      uBottom: { value: new THREE.Color(0xa9d4f5) },
      uSunColor: { value: new THREE.Color(0xfff2d0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunSize: { value: 0.02 },
      uSunStrength: { value: 1 },
    };

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 40, 24),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      })
    );
    mesh.name = 'sky';
    mesh.frustumCulled = false;
    this.mesh = mesh;

    // ── Stars ──────────────────────────────────────────────────
    const count = 1500;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      // Rejection-sample the upper hemisphere so none sit under the grass.
      do {
        v.set(Math.random() * 2 - 1, Math.random(), Math.random() * 2 - 1);
      } while (v.length() > 1 || v.y < 0.02);
      v.normalize().multiplyScalar(radius * 0.94);
      positions.set([v.x, v.y, v.z], i * 3);
      sizes[i] = 1.2 + Math.random() * 2.4;
    }

    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uPixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        uniform float uPixelRatio;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        void main() {
          // Soft round point.
          float d = distance(gl_PointCoord, vec2(0.5));
          float a = smoothstep(0.5, 0.08, d);
          gl_FragColor = vec4(vec3(1.0, 0.98, 0.92), a * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    const stars = new THREE.Points(starGeo, this.starMaterial);
    stars.name = 'stars';
    stars.frustumCulled = false;
    this.stars = stars;

    this.group = new THREE.Group();
    this.group.name = 'skySystem';
    this.group.add(mesh, stars);
  }

  /** @param {{top: THREE.Color, bottom: THREE.Color, sun: THREE.Color, starOpacity: number}} state */
  apply(state, sunDir, pixelRatio) {
    this.uniforms.uTop.value.copy(state.skyTop);
    this.uniforms.uBottom.value.copy(state.skyBottom);
    this.uniforms.uSunColor.value.copy(state.sunColor);
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunStrength.value = state.sunStrength;
    this.starMaterial.uniforms.uOpacity.value = state.starOpacity;
    this.starMaterial.uniforms.uPixelRatio.value = pixelRatio;
  }

  /** Keep the dome centred on the viewer and the stars turning slowly. */
  update(camera, elapsed) {
    this.group.position.copy(camera.position);
    this.stars.rotation.y = elapsed * 0.004;
  }
}
