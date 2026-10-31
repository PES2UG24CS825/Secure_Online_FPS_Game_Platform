/**
 * SecureFPS: High-Visibility Procedural Tactical Texture Generator
 * Generates crisp, high-contrast, professional textures using HTML5 Canvas
 * completely eliminating external asset dependencies while maximizing clarity.
 */
class TextureGenerator {
  /**
   * Generates a high-contrast, professional tactical arena floor tile texture
   */
  static createFloorTexture(size = 512) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Base tactical composite plate (high-contrast medium slate gray)
    ctx.fillStyle = '#283344';
    ctx.fillRect(0, 0, size, size);

    // Subtle brushed metallic texture
    const imgData = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 16;
      imgData.data[i] = Math.min(255, Math.max(0, imgData.data[i] + noise));
      imgData.data[i + 1] = Math.min(255, Math.max(0, imgData.data[i + 1] + noise + 2));
      imgData.data[i + 2] = Math.min(255, Math.max(0, imgData.data[i + 2] + noise + 6));
    }
    ctx.putImageData(imgData, 0, 0);

    // Grid tile dividers (4x4 sub-tiles per texture unit)
    const subTiles = 4;
    const step = size / subTiles;

    ctx.strokeStyle = '#1a222e';
    ctx.lineWidth = 4;

    for (let i = 0; i <= size; i += step) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();
    }

    // High-visibility inner tile border highlights
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.22)';
    ctx.lineWidth = 1.5;
    for (let x = 0; x < size; x += step) {
      for (let y = 0; y < size; y += step) {
        ctx.strokeRect(x + 5, y + 5, step - 10, step - 10);
      }
    }

    // Tactical crosshairs at tile intersections
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 2;
    const crossSize = 8;
    for (let x = 0; x <= size; x += step) {
      for (let y = 0; y <= size; y += step) {
        ctx.beginPath();
        ctx.moveTo(x - crossSize, y);
        ctx.lineTo(x + crossSize, y);
        ctx.moveTo(x, y - crossSize);
        ctx.lineTo(x, y + crossSize);
        ctx.stroke();
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  /**
   * Generates a fortified tactical wall panel texture
   */
  static createWallTexture(size = 512) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Base gunmetal gray
    ctx.fillStyle = '#222b38';
    ctx.fillRect(0, 0, size, size);

    // Panel seams
    ctx.strokeStyle = '#121720';
    ctx.lineWidth = 5;

    // Horizontal main division
    ctx.beginPath();
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
    ctx.stroke();

    // Vertical subdivisions
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
    ctx.stroke();

    // Rivet dots along seams
    ctx.fillStyle = '#475569';
    const rivets = [
      [14, 14], [size - 14, 14], [14, size - 14], [size - 14, size - 14],
      [size / 2 - 14, 14], [size / 2 + 14, 14],
      [14, size / 2 - 14], [14, size / 2 + 14],
      [size - 14, size / 2 - 14], [size - 14, size / 2 + 14]
    ];
    rivets.forEach(([rx, ry]) => {
      ctx.beginPath();
      ctx.arc(rx, ry, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    // Metallic highlight accents
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(10, 10, size / 2 - 20, size / 2 - 20);
    ctx.fillRect(size / 2 + 10, size / 2 + 10, size / 2 - 20, size / 2 - 20);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  /**
   * Generates an industrial hazard yellow/black caution stripe
   */
  static createHazardTexture(size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#f59e0b'; // High-visibility amber
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#181e28'; // Dark gunmetal
    const stripeWidth = 26;
    for (let x = -size; x < size * 2; x += stripeWidth * 2) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + stripeWidth, 0);
      ctx.lineTo(x + stripeWidth - size, size);
      ctx.lineTo(x - size, size);
      ctx.closePath();
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  /**
   * Generates a tactical bullseye target texture for training lane
   */
  static createTargetTexture(size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#222a36';
    ctx.fillRect(0, 0, size, size);

    const center = size / 2;
    const rings = [
      { r: 115, color: '#334155' },
      { r: 92, color: '#f8fafc' },
      { r: 68, color: '#1e293b' },
      { r: 46, color: '#00f0ff' },
      { r: 24, color: '#ff0055' },
      { r: 10, color: '#f8fafc' }
    ];

    rings.forEach(ring => {
      ctx.beginPath();
      ctx.arc(center, center, ring.r, 0, Math.PI * 2);
      ctx.fillStyle = ring.color;
      ctx.fill();
    });

    // Crosshair lines over target
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(center, 8);
    ctx.lineTo(center, size - 8);
    ctx.moveTo(8, center);
    ctx.lineTo(size - 8, center);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    return texture;
  }

  /**
   * Generates authentic "CS-3D" military hook-and-loop velcro chest/shoulder patch
   */
  static createPatchTexture(team = 'blue', label = 'CS-3D', sizeW = 256, sizeH = 128) {
    const canvas = document.createElement('canvas');
    canvas.width = sizeW;
    canvas.height = sizeH;
    const ctx = canvas.getContext('2d');

    const isBlue = team === 'blue';
    const accentColor = isBlue ? '#00f0ff' : '#ff0055';
    const darkAccent = isBlue ? '#03405c' : '#5c0318';

    // Patch background (textured dark olive/charcoal velcro)
    ctx.fillStyle = '#1c1f24';
    ctx.fillRect(0, 0, sizeW, sizeH);

    // Subtle velcro micro-texture
    const imgData = ctx.getImageData(0, 0, sizeW, sizeH);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 18;
      imgData.data[i] = Math.min(255, Math.max(0, imgData.data[i] + noise));
      imgData.data[i + 1] = Math.min(255, Math.max(0, imgData.data[i + 1] + noise));
      imgData.data[i + 2] = Math.min(255, Math.max(0, imgData.data[i + 2] + noise));
    }
    ctx.putImageData(imgData, 0, 0);

    // Stitched perimeter border
    ctx.strokeStyle = '#2b3038';
    ctx.lineWidth = 5;
    ctx.strokeRect(4, 4, sizeW - 8, sizeH - 8);

    // Team Accent top/bottom stripes
    ctx.fillStyle = darkAccent;
    ctx.fillRect(8, 8, sizeW - 16, 6);
    ctx.fillRect(8, sizeH - 14, sizeW - 16, 6);

    ctx.fillStyle = accentColor;
    ctx.fillRect(8, 12, sizeW - 16, 2);

    // Bold military stencil "CS-3D"
    ctx.fillStyle = '#f1f5f9';
    ctx.font = 'bold 52px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 6;
    ctx.fillText(label, sizeW / 2, sizeH / 2 - 2);

    // Subtitle: SPECIAL FORCES / TEAM IDENTIFICATION
    ctx.shadowBlur = 0;
    ctx.fillStyle = accentColor;
    ctx.font = 'bold 15px "Courier New", monospace';
    ctx.fillText(isBlue ? 'TF-GHOST // BLUE' : 'HOSTILE // RED', sizeW / 2, sizeH / 2 + 34);

    const texture = new THREE.CanvasTexture(canvas);
    return texture;
  }

  /**
   * Generates tactical ripstop camo fabric texture
   */
  static createCamoFabricTexture(type = 'dark', size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const baseColor = type === 'tan' ? '#4a3f31' : '#1f242c';
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, size, size);

    // Ripstop crosshatch grid
    ctx.strokeStyle = type === 'tan' ? 'rgba(30, 24, 18, 0.4)' : 'rgba(15, 18, 24, 0.5)';
    ctx.lineWidth = 1;
    const step = 8;
    for (let i = 0; i < size; i += step) {
      ctx.beginPath();
      ctx.moveTo(i, 0); ctx.lineTo(i, size);
      ctx.moveTo(0, i); ctx.lineTo(size, i);
      ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }
}
