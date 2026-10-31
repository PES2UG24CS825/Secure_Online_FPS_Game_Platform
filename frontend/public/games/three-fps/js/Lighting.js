/**
 * SecureFPS: Lighting and Atmospheric System
 * Establishes cinematic illumination, soft cascaded PCF shadows,
 * hemisphere ambient fill, sky dome, and tactical accent lights.
 */
class Lighting {
  constructor(scene) {
    this.scene = scene;
    this.init();
  }

  init() {
    // Atmospheric fog matching clean sky horizon
    this.scene.fog = new THREE.FogExp2(0x1e293b, 0.009);
    this.scene.background = new THREE.Color(0x1e293b);

    // Build procedural sky dome
    this.createSkyDome();

    // Hemisphere Light (Sky illumination + warm ground bounce fill)
    // Ensures shadows are never pure black!
    const hemiLight = new THREE.HemisphereLight(0xa5c4f2, 0x334155, 0.95);
    hemiLight.position.set(0, 60, 0);
    this.scene.add(hemiLight);

    // Main Directional Sun Light with Shadows
    const sunLight = new THREE.DirectionalLight(0xfffaed, 1.35);
    sunLight.position.set(-40, 65, 35);
    sunLight.castShadow = true;

    // Shadow map configuration optimized for crisp PCF shadows
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 180;

    // Tightly fitted shadow camera frustum covering the arena
    const d = 56;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.0003;
    sunLight.shadow.radius = 1.5;

    this.scene.add(sunLight);
    this.sunLight = sunLight;

    // Ambient tactical fill light for uniform visibility
    const ambLight = new THREE.AmbientLight(0x2a374a, 0.55);
    this.scene.add(ambLight);

    // Cyber accent point lights
    this.createAccentLights();
  }

  /**
   * Procedural Sky Dome
   */
  createSkyDome() {
    const vertexShader = `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + offset).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
      }
    `;

    const uniforms = {
      topColor: { value: new THREE.Color(0x132136) },    // Deep tactical zenith
      bottomColor: { value: new THREE.Color(0x2d3f56) }, // Horizon light
      offset: { value: 10 },
      exponent: { value: 0.7 }
    };

    const skyGeo = new THREE.SphereGeometry(250, 32, 15);
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
      uniforms: uniforms,
      side: THREE.BackSide
    });

    const sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(sky);
  }

  createAccentLights() {
    const lightsData = [
      { x: 0, y: 6.0, z: 0, color: 0x00f0ff, intensity: 1.8, distance: 22 },       // Central spire
      { x: -32, y: 4.0, z: 20, color: 0x00f0ff, intensity: 1.4, distance: 18 },    // Shooting range
      { x: 28, y: 5.0, z: -10, color: 0xffb703, intensity: 1.4, distance: 18 },   // Parkour course
      { x: 0, y: 3.5, z: 32, color: 0x00f0ff, intensity: 1.2, distance: 16 }       // South spawn gate
    ];

    lightsData.forEach(data => {
      const pLight = new THREE.PointLight(data.color, data.intensity, data.distance, 2);
      pLight.position.set(data.x, data.y, data.z);
      this.scene.add(pLight);
    });
  }
}
