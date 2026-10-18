(() => {
    "use strict";

    const canvas = document.getElementById("game-canvas");
    const statusEl = document.getElementById("game-status");
    const toastEl = document.getElementById("toast");
    const powerButton = document.getElementById("power-btn");
    const resetButton = document.getElementById("reset-btn");
    const cameraLeftButton = document.getElementById("camera-left");
    const cameraRightButton = document.getElementById("camera-right");
    const cameraUpButton = document.getElementById("camera-up");
    const cameraDownButton = document.getElementById("camera-down");
    const cameraResetButton = document.getElementById("camera-reset");
    const hintEl = document.getElementById("camera-hint");

    if (!window.THREE) {
        statusEl.textContent = "The 3D engine could not load. Check your internet connection and reload.";
        powerButton.disabled = true;
        return;
    }

    const THREE = window.THREE;
    const COLS = 8;
    const ROWS = 7;
    const STEP = 1.12;
    const START = { r: 4, c: 0 };
    const TARGET = { r: 3, c: 5 };
    const BLOCKERS = new Set([
        "0,2", "0,4", "0,6", "1,0", "1,7", "2,3", "2,7",
        "3,0", "3,7", "4,6", "5,1", "5,4", "6,2", "6,6"
    ]);
    const TILE_CUTS = new Set([
        "0,0", "0,1", "0,7", "1,0", "1,7", "2,7",
        "3,0", "3,7", "4,7", "5,0", "5,7", "6,0",
        "6,1", "6,7"
    ]);
    const COLORS = [0xff28d7, 0xffae24, 0x00cfff, 0xff28d7];
    const DIRS = [
        { dr: -1, dc: 0 },
        { dr: 0, dc: 1 },
        { dr: 1, dc: 0 },
        { dr: 0, dc: -1 }
    ];
    const SLASH_REFLECTION = [1, 0, 3, 2];
    const BACKSLASH_REFLECTION = [3, 2, 1, 0];
    const key = (r, c) => `${r},${c}`;
    const worldX = (c) => (c - (COLS - 1) / 2) * STEP;
    const worldZ = (r) => (r - (ROWS - 1) / 2) * STEP;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070c17);
    scene.fog = new THREE.FogExp2(0x070c17, 0.019);

    const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 120);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = .82;
    if ("outputColorSpace" in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    else if ("outputEncoding" in renderer) renderer.outputEncoding = THREE.sRGBEncoding;

    const hemi = new THREE.HemisphereLight(0x9bb7d8, 0x1c1b20, .16);
    scene.add(hemi);
    const keyLight = new THREE.DirectionalLight(0xf7e4cd, .28);
    keyLight.position.set(-5, 11, 7);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.left = -12;
    keyLight.shadow.camera.right = 12;
    keyLight.shadow.camera.top = 12;
    keyLight.shadow.camera.bottom = -12;
    keyLight.shadow.bias = -0.00035;
    scene.add(keyLight);

    const pinkLight = new THREE.PointLight(0xff38d8, 14, 7, 2);
    pinkLight.position.set(worldX(START.c), 1.7, worldZ(START.r));
    scene.add(pinkLight);
    const coreLight = new THREE.PointLight(0x16cfff, 16, 8, 2);
    coreLight.position.set(worldX(TARGET.c), 1.6, worldZ(TARGET.r));
    scene.add(coreLight);
    const amberLight = new THREE.PointLight(0xff962e, 12, 8, 2);
    amberLight.position.set(-3.8, 1.05, .2);
    scene.add(amberLight);

    const world = new THREE.Group();
    scene.add(world);
    const platform = new THREE.Group();
    world.add(platform);

    const tileMeshes = new Map();
    const mirrors = new Map();
    const tileObjects = [];
    const rotatingRings = [];
    const beamGroup = new THREE.Group();
    world.add(beamGroup);
    const mirrorGroup = new THREE.Group();
    world.add(mirrorGroup);
    let won = false;
    let toastTimer = 0;
    let selectedCell = { r: START.r, c: START.c + 1 };
    let orbit = -0.48;
    let elevation = 0.76;
    let cameraDistance = 18.2;
    let dragging = false;
    let dragMoved = false;
    let pointerX = 0;
    let pointerY = 0;
    let lastCompactLayout = null;
    let pinchDistance = 0;
    const activePointers = new Map();

    const mat = (color, roughness = .8, metalness = .1, extra = {}) =>
        new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
    const stoneMaterials = [
        mat(0x343940, .96, .05),
        mat(0x41413e, .94, .06),
        mat(0x3c4145, .92, .1),
        mat(0x4a443d, .94, .06)
    ];
    const tileTopMaterials = [
        mat(0x100d14, .96, .04, { emissive: 0x160713, emissiveIntensity: .32 }),
        mat(0x1b100b, .97, .03, { emissive: 0x201006, emissiveIntensity: .3 }),
        mat(0x0d161e, .94, .04, { emissive: 0x061725, emissiveIntensity: .32 }),
        mat(0x1b170e, .95, .04, { emissive: 0x1a1005, emissiveIntensity: .3 })
    ];
    const tileSide = mat(0x131a22, .88, .14);
    const darkMetal = mat(0x202832, .55, .65);
    const trimMetal = mat(0x515964, .48, .72);
    const crackMaterial = new THREE.LineBasicMaterial({ color: 0x4b4440, transparent: true, opacity: .95 });
    const glowMaterial = (color, opacity = 1) =>
        new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 2.6,
            roughness: .24,
            metalness: .08,
            transparent: opacity < 1,
            opacity,
            depthWrite: opacity >= 1
        });

    function addBox(parent, size, position, material, options = {}) {
        const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(position[0], position[1], position[2]);
        mesh.castShadow = options.castShadow !== false;
        mesh.receiveShadow = options.receiveShadow !== false;
        if (options.rotation) mesh.rotation.set(...options.rotation);
        parent.add(mesh);
        return mesh;
    }

    function addCylinder(parent, radiusTop, radiusBottom, height, position, material, segments = 12) {
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
            material
        );
        mesh.position.set(...position);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
        return mesh;
    }

    function makeBackdrop() {
        const voidFloor = new THREE.Mesh(
            new THREE.PlaneGeometry(140, 140),
            new THREE.MeshStandardMaterial({ color: 0x080d16, roughness: 1, metalness: .05 })
        );
        voidFloor.rotation.x = -Math.PI / 2;
        voidFloor.position.y = -2.7;
        voidFloor.receiveShadow = true;
        scene.add(voidFloor);

        const points = [];
        for (let i = 0; i < 420; i++) {
            points.push((Math.random() - .5) * 90, Math.random() * 26 - 2, (Math.random() - .5) * 90);
        }
        const starGeometry = new THREE.BufferGeometry();
        starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
        const stars = new THREE.Points(
            starGeometry,
            new THREE.PointsMaterial({ color: 0x99c8ea, size: .035, transparent: true, opacity: .55, sizeAttenuation: true })
        );
        scene.add(stars);
    }

    function makePlatformBase() {
        const shape = new THREE.Shape();
        shape.moveTo(-4.5, -3.6);
        shape.lineTo(-3.6, -4.05);
        shape.lineTo(3.45, -4.05);
        shape.lineTo(4.25, -3.48);
        shape.lineTo(4.3, -2.7);
        shape.lineTo(4.85, -2.36);
        shape.lineTo(4.85, 2.45);
        shape.lineTo(4.1, 3.45);
        shape.lineTo(2.75, 3.58);
        shape.lineTo(2.25, 4.05);
        shape.lineTo(-3.9, 4.05);
        shape.lineTo(-4.7, 3.28);
        shape.lineTo(-4.7, -2.65);
        shape.lineTo(-4.5, -3.6);

        const geometry = new THREE.ExtrudeGeometry(shape, {
            depth: .82,
            bevelEnabled: true,
            bevelSegments: 3,
            steps: 1,
            bevelSize: .13,
            bevelThickness: .14,
            curveSegments: 2
        });
        geometry.rotateX(-Math.PI / 2);
        const foundation = new THREE.Mesh(geometry, mat(0x333941, .82, .45));
        foundation.position.y = -.97;
        foundation.castShadow = true;
        foundation.receiveShadow = true;
        platform.add(foundation);

        const lowerShape = shape.clone();
        const lowerGeo = new THREE.ExtrudeGeometry(lowerShape, {
            depth: .32,
            bevelEnabled: true,
            bevelSegments: 2,
            steps: 1,
            bevelSize: .09,
            bevelThickness: .08,
            curveSegments: 2
        });
        lowerGeo.rotateX(-Math.PI / 2);
        const lower = new THREE.Mesh(lowerGeo, mat(0x1b232c, .62, .66));
        lower.position.set(0, -1.52, 0);
        lower.castShadow = true;
        platform.add(lower);

        const rim = new THREE.Mesh(
            new THREE.TorusGeometry(1, .035, 6, 8),
            glowMaterial(0x3faec9, .64)
        );
        // The rim is replaced by short edge markers so the platform remains irregular.
        rim.visible = false;
        platform.add(rim);

        const underglow = new THREE.PointLight(0x2181b3, 32, 13, 2);
        underglow.position.set(0, -1.1, 0);
        platform.add(underglow);
    }

    function hasTile(r, c) {
        return r >= 0 && r < ROWS && c >= 0 && c < COLS && !TILE_CUTS.has(key(r, c));
    }

    function makeCracks(parent, x, z, seed) {
        const rand = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        if (rand() > .62) return;
        const cx = x + (rand() - .5) * .5;
        const cz = z + (rand() - .5) * .5;
        const points = [
            new THREE.Vector3(cx - .08, .175, cz - .25),
            new THREE.Vector3(cx + .02, .175, cz - .08),
            new THREE.Vector3(cx - .11, .175, cz + .03),
            new THREE.Vector3(cx + .04, .175, cz + .22)
        ];
        parent.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), crackMaterial));
        const branch = [
            points[1],
            new THREE.Vector3(cx + .19, .175, cz - .2),
            new THREE.Vector3(cx + .29, .175, cz - .17)
        ];
        parent.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(branch), crackMaterial));
    }

    function makeTiles() {
        const slabGeometry = new THREE.BoxGeometry(STEP - .035, .2, STEP - .035);
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if (!hasTile(r, c)) continue;
                const x = worldX(c);
                const z = worldZ(r);
                const cell = new THREE.Group();
                cell.position.set(x, 0, z);
                platform.add(cell);

                const slab = new THREE.Mesh(slabGeometry, tileSide);
                slab.position.y = -.01;
                slab.receiveShadow = true;
                slab.castShadow = true;
                cell.add(slab);

                const half = (STEP - .085) / 2;
                const chip = ((r * 11 + c * 7) % 5) * .018;
                const tileShape = new THREE.Shape();
                tileShape.moveTo(-half * .82, -half);
                tileShape.lineTo(half * (.72 + chip), -half);
                tileShape.lineTo(half, -half * .7);
                tileShape.lineTo(half * .96, half * .62);
                tileShape.lineTo(half * (.66 - chip), half);
                tileShape.lineTo(-half * .81, half * .96);
                tileShape.lineTo(-half, half * .56);
                tileShape.lineTo(-half * .95, -half * .68);
                tileShape.closePath();
                const topGeometry = new THREE.ExtrudeGeometry(tileShape, {
                    depth: .075,
                    bevelEnabled: false,
                    curveSegments: 1
                });
                topGeometry.rotateX(-Math.PI / 2);
                const top = new THREE.Mesh(
                    topGeometry,
                    tileTopMaterials[(r * 3 + c * 5) % tileTopMaterials.length].clone()
                );
                top.position.y = .088;
                top.castShadow = true;
                top.receiveShadow = true;
                cell.add(top);
                top.userData.row = r;
                top.userData.col = c;
                top.userData.isTile = true;
                tileMeshes.set(key(r, c), top);
                tileObjects.push(top);

                makeCracks(cell, 0, 0, (r + 1) * 197 + c * 791);
                if ((r * 5 + c * 3) % 4 === 0) {
                    addBox(cell, [STEP - .26, .012, .018], [0, .138, -.31], mat(0x343536, .99, .01), { castShadow: false });
                }
            }
        }

        const edgeMat = glowMaterial(0x3b9fc1, .72);
        [
            [[-4.35, .06, -3.92], [7.1, .025, .045]],
            [[4.68, .06, -2.1], [.04, .025, 4.1]],
            [[-4.65, .06, -.1], [.04, .025, 5.6]],
            [[-.8, .06, 3.92], [6.1, .025, .04]]
        ].forEach(([pos, size]) => addBox(platform, size, pos, edgeMat, { castShadow: false, receiveShadow: false }));
    }

    function makeCrystals() {
        const crystalMaterial = (color) => new THREE.MeshBasicMaterial({
            color,
            toneMapped: false
        });

        function crystal(r, c, color, tall = .82, source = false) {
            const x = worldX(c);
            const z = worldZ(r);
            addCylinder(platform, .27, .34, .16, [x, .23, z], darkMetal, 6);
            addCylinder(platform, .18, .26, .08, [x, .35, z], trimMetal, 6);

            const mesh = new THREE.Mesh(
                new THREE.BoxGeometry(.24, tall, .24),
                crystalMaterial(color)
            );
            mesh.position.set(x, .4 + tall / 2, z);
            mesh.rotation.y = Math.PI / 4;
            mesh.castShadow = true;
            platform.add(mesh);

            const cap = new THREE.Mesh(
                new THREE.OctahedronGeometry(.16, 0),
                crystalMaterial(color)
            );
            cap.scale.set(.75, .34, .75);
            cap.position.set(x, .4 + tall + .025, z);
            cap.castShadow = true;
            platform.add(cap);

            if (source) {
                addBox(platform, [.38, .045, .38], [x, .19, z], glowMaterial(color), { castShadow: false });
            }
        }

        crystal(START.r, START.c, 0xff65dc, 1.22, true);
        crystal(0, 5, 0x57cfff, .9);
        crystal(5, 7, 0xffc15f, 1.02);
        crystal(1, 4, 0xff7de6, .76);
    }

    function makeCore() {
        const x = worldX(TARGET.c);
        const z = worldZ(TARGET.r);
        addCylinder(platform, .92, 1.14, .18, [x, .2, z], darkMetal, 48);
        addCylinder(platform, .8, .93, .105, [x, .32, z], trimMetal, 48);

        const ringMaterial = new THREE.MeshStandardMaterial({
            color: 0x62ddff,
            emissive: 0x2bc9ff,
            emissiveIntensity: 1.1,
            metalness: .4,
            roughness: .3,
            transparent: true,
            opacity: .83
        });
        [0.86, 0.62, 0.34].forEach((radius, index) => {
            const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, index === 0 ? .035 : .018, 8, 64), ringMaterial);
            ring.rotation.x = Math.PI / 2;
            ring.position.set(x, .48 + index * .012, z);
            platform.add(ring);
            ring.userData.spinRate = index % 2 ? -.2 : .12;
            rotatingRings.push(ring);
        });

        const coreMaterial = glowMaterial(0x39caff);
        coreMaterial.emissiveIntensity = 1.1;
        const coreDisc = addCylinder(platform, .32, .38, .13, [x, .49, z], coreMaterial, 12);
        coreDisc.position.y = .56;
        const hologram = new THREE.Group();
        hologram.position.set(x, .92, z);
        platform.add(hologram);
        const hologramDisc = new THREE.Mesh(
            new THREE.CircleGeometry(.52, 64),
            new THREE.MeshBasicMaterial({
                color: 0x45d9ff,
                transparent: true,
                opacity: .14,
                side: THREE.DoubleSide,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            })
        );
        hologramDisc.rotation.x = -Math.PI / 2;
        hologram.add(hologramDisc);
        const glyphRing = new THREE.Mesh(
            new THREE.TorusGeometry(.53, .012, 6, 64),
            new THREE.MeshBasicMaterial({ color: 0x8af5ff, transparent: true, opacity: .8, blending: THREE.AdditiveBlending })
        );
        glyphRing.rotation.x = Math.PI / 2;
        hologram.add(glyphRing);
        const glyphs = new THREE.Group();
        for (let i = 0; i < 36; i++) {
            const angle = i / 36 * Math.PI * 2;
            const radius = i % 3 === 0 ? .44 : .48;
            const tick = new THREE.Mesh(
                new THREE.BoxGeometry(i % 3 === 0 ? .055 : .025, .009, i % 3 === 0 ? .11 : .055),
                new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? 0xc5ffff : 0x64dfff, transparent: true, opacity: .85, blending: THREE.AdditiveBlending })
            );
            tick.position.set(Math.cos(angle) * radius, .008, Math.sin(angle) * radius);
            tick.rotation.y = -angle;
            glyphs.add(tick);
        }
        hologram.add(glyphs);
        hologram.userData.spinRate = .14;
        rotatingRings.push(hologram);
        const halo = new THREE.PointLight(0x40d8ff, 7, 3.5, 2);
        halo.position.set(x, 1.1, z);
        platform.add(halo);

        const ticks = new THREE.Group();
        for (let i = 0; i < 24; i++) {
            const angle = i / 24 * Math.PI * 2;
            const radius = .73;
            const tick = addBox(
                ticks,
                [.12, .025, i % 3 === 0 ? .045 : .025],
                [Math.cos(angle) * radius, .45, Math.sin(angle) * radius],
                i % 3 === 0 ? glowMaterial(0x7ae9ff) : ringMaterial,
                { castShadow: false }
            );
            tick.rotation.y = -angle;
        }
        ticks.position.set(x, 0, z);
        platform.add(ticks);
    }

    function makeBlockers() {
        const geo = new THREE.DodecahedronGeometry(.45, 0);
        for (const coord of BLOCKERS) {
            const [r, c] = coord.split(",").map(Number);
            if (!hasTile(r, c)) continue;
            const rock = new THREE.Mesh(geo, stoneMaterials[(r + c) % stoneMaterials.length]);
            rock.scale.set(.88, .9 + ((r + c) % 3) * .11, .82);
            rock.position.set(worldX(c), .39, worldZ(r));
            rock.rotation.set(.1 * (r % 3), .3 * c, .2 * (c % 3));
            rock.castShadow = true;
            rock.receiveShadow = true;
            platform.add(rock);

            const shard = new THREE.Mesh(
                new THREE.DodecahedronGeometry(.18, 0),
                trimMetal
            );
            shard.scale.set(1.2, .48, .82);
            shard.position.set(worldX(c) + .24, .16, worldZ(r) - .15);
            shard.rotation.y = .8 + c;
            shard.castShadow = true;
            platform.add(shard);
        }
    }

    function makeArchitecture() {
        const columnMat = new THREE.MeshBasicMaterial({ color: 0x101a29, toneMapped: false });
        const footMat = mat(0x222c39, .5, .78);
        const bars = new THREE.MeshStandardMaterial({ color: 0x202c3a, roughness: .58, metalness: .42 });
        const railGlow = glowMaterial(0x4b9bc1, .8);

        function column(x, z, h, color) {
            addBox(world, [.82, .22, .82], [x, -1.88, z], footMat);
            addBox(world, [.75, h, .75], [x, h / 2 - 1.8, z], columnMat);
            addBox(world, [1.04, .16, 1.04], [x, -1.67, z], footMat);
            addBox(world, [.91, .15, .91], [x, h - 1.88, z], footMat);
            addBox(world, [.79, .055, .79], [x, h * .58 - 1.8, z], glowMaterial(color));
        }

        column(-5.15, -3.3, 8.3, 0x55b9e9);
        column(-3.1, -4.72, 6.8, 0xff8b5f);
        column(-.35, -4.78, 8.9, 0xff825f);
        column(2.45, -4.65, 7.5, 0x58aefa);
        column(4.8, -3.7, 8.7, 0x397bad);
        column(5.5, 2.8, 7.2, 0x407fb4);

        function beamBar(a, b, thickness, material) {
            const start = new THREE.Vector3(...a);
            const end = new THREE.Vector3(...b);
            const direction = new THREE.Vector3().subVectors(end, start);
            const bar = new THREE.Mesh(
                new THREE.BoxGeometry(thickness, thickness, direction.length()),
                material
            );
            bar.position.copy(start).add(end).multiplyScalar(.5);
            bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize());
            bar.castShadow = true;
            world.add(bar);
        }

        const bridgeY = 4.1;
        const bridgeZ = -5.9;
        beamBar([-6.6, bridgeY, bridgeZ], [6.6, bridgeY, bridgeZ], .13, bars);
        beamBar([-6.6, bridgeY + .9, bridgeZ], [6.6, bridgeY + .9, bridgeZ], .13, bars);
        for (let i = 0; i <= 12; i++) {
            const x = -6.6 + i * 1.1;
            beamBar([x, bridgeY, bridgeZ], [x, bridgeY + .9, bridgeZ], .075, bars);
            if (i < 12) {
                const x2 = x + 1.1;
                beamBar([x, bridgeY + (i % 2 ? .9 : 0), bridgeZ], [x2, bridgeY + (i % 2 ? 0 : .9), bridgeZ], .065, bars);
            }
        }
        beamBar([-6.6, bridgeY - .18, bridgeZ + .09], [6.6, bridgeY - .18, bridgeZ + .09], .025, railGlow);

        // A distant side truss frames the void without covering the play platform.
        const sideZ = 1.9;
        beamBar([6.1, 3.3, -3.2], [6.1, 3.3, 5.7], .12, bars);
        beamBar([6.1, 4.05, -3.2], [6.1, 4.05, 5.7], .12, bars);
        for (let i = 0; i < 9; i++) {
            const z = -3.2 + i * 1.1;
            beamBar([6.1, 3.3, z], [6.1, 4.05, z], .06, bars);
            if (i < 8) beamBar([6.1, 3.3 + (i % 2 ? .75 : 0), z], [6.1, 3.3 + (i % 2 ? 0 : .75), z + 1.1], .055, bars);
        }
    }

    function createMirror(r, c, slash = true) {
        const group = new THREE.Group();
        const x = worldX(c);
        const z = worldZ(r);
        group.position.set(x, .18, z);
        group.userData.key = key(r, c);

        const foot = addBox(group, [.55, .1, .42], [0, .07, 0], darkMetal);
        foot.material = darkMetal;
        addBox(group, [.48, .055, .3], [0, .13, 0], trimMetal);

        // An upright glass reflector shows as a slash/backslash from the high camera.
        addBox(group, [.63, .78, .085], [0, .57, 0], mat(0x264456, .18, .72, {
            emissive: 0x12374f,
            emissiveIntensity: 1.5
        }));
        addBox(group, [.49, .63, .018], [0, .59, .053], new THREE.MeshStandardMaterial({
            color: 0x85eeff,
            emissive: 0x38cfff,
            emissiveIntensity: 2.2,
            metalness: .52,
            roughness: .15,
            transparent: true,
            opacity: .83
        }));
        addBox(group, [.67, .07, .12], [0, .98, 0], trimMetal);
        addBox(group, [.7, .035, .14], [0, .2, 0], glowMaterial(0x71eaff, .9));
        addBox(group, [.07, .82, .11], [-.31, .59, .015], trimMetal);
        addBox(group, [.07, .82, .11], [.31, .59, .015], trimMetal);

        group.rotation.y = slash ? Math.PI / 4 : -Math.PI / 4;
        group.traverse((object) => {
            if (object.isMesh) object.castShadow = true;
        });
        mirrorGroup.add(group);
        mirrors.set(key(r, c), { slash, group });
        return group;
    }

    function updateMirrorAngle(mirror) {
        mirror.group.rotation.y = mirror.slash ? Math.PI / 4 : -Math.PI / 4;
        mirror.group.children.forEach((part) => {
            if (part.material && part.material.emissive) {
                part.material.emissiveIntensity = mirror.slash ? 2.3 : 1.7;
            }
        });
    }

    function clearGroup(group) {
        for (let i = group.children.length - 1; i >= 0; i--) {
            const child = group.children[i];
            group.remove(child);
            child.traverse((object) => {
                if (!object.isMesh && !object.isLine) return;
                object.geometry?.dispose();
                if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
                else object.material?.dispose();
            });
        }
    }

    function cellWorld(r, c, y = .61) {
        return new THREE.Vector3(worldX(c), y, worldZ(r));
    }

    function routeBeam() {
        const points = [];
        const segments = [];
        const visited = new Set();
        let r = START.r;
        let c = START.c;
        let direction = 1;
        let colorIndex = 0;
        let outcome = "open";
        points.push(cellWorld(r, c, .74));

        for (let step = 0; step < ROWS * COLS * 2; step++) {
            const state = `${r},${c},${direction}`;
            if (visited.has(state)) {
                outcome = "loop";
                break;
            }
            visited.add(state);

            const nextR = r + DIRS[direction].dr;
            const nextC = c + DIRS[direction].dc;
            if (!hasTile(nextR, nextC)) {
                outcome = "edge";
                break;
            }
            const nextKey = key(nextR, nextC);
            const nextPoint = cellWorld(nextR, nextC, .74);
            segments.push({ from: points[points.length - 1], to: nextPoint, color: COLORS[colorIndex] });
            r = nextR;
            c = nextC;
            points.push(nextPoint);

            if (r === TARGET.r && c === TARGET.c) {
                outcome = "win";
                break;
            }
            if (BLOCKERS.has(nextKey)) {
                outcome = "blocked";
                break;
            }
            const mirror = mirrors.get(nextKey);
            if (mirror) {
                direction = mirror.slash
                    ? SLASH_REFLECTION[direction]
                    : BACKSLASH_REFLECTION[direction];
                colorIndex = (colorIndex + 1) % COLORS.length;
            }
        }
        drawBeam(segments, points);
        return { outcome, points, segments };
    }

    function drawBeam(segments, points) {
        clearGroup(beamGroup);
        segments.forEach(({ from, to, color }) => {
            const delta = new THREE.Vector3().subVectors(to, from);
            const length = delta.length();
            const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(.5);
            const glow = new THREE.Mesh(
                new THREE.CylinderGeometry(.12, .12, length, 8),
                new THREE.MeshBasicMaterial({
                    color,
                    transparent: true,
                    opacity: .28,
                    depthWrite: false,
                    blending: THREE.AdditiveBlending,
                    toneMapped: false
                })
            );
            glow.position.copy(midpoint);
            glow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
            beamGroup.add(glow);

            const core = new THREE.Mesh(
                new THREE.CylinderGeometry(.052, .052, length, 8),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, toneMapped: false })
            );
            core.position.copy(midpoint);
            core.quaternion.copy(glow.quaternion);
            beamGroup.add(core);

            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(.055, 8, 8),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, toneMapped: false })
            );
            dot.position.copy(to);
            beamGroup.add(dot);
        });
    }

    function setStatus(message) {
        statusEl.textContent = message;
    }

    function showToast(message, kind = "") {
        window.clearTimeout(toastTimer);
        toastEl.textContent = message;
        toastEl.className = `toast show ${kind}`.trim();
        toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 2200);
    }

    function interactCell(r, c) {
        if (won) return;
        const cellKey = key(r, c);
        if (BLOCKERS.has(cellKey)) {
            showToast("Stone blocks this tile. Choose an open platform tile.", "error");
            return;
        }
        if (cellKey === key(START.r, START.c) || cellKey === key(TARGET.r, TARGET.c)) return;

        const existing = mirrors.get(cellKey);
        if (existing) {
            existing.slash = !existing.slash;
            updateMirrorAngle(existing);
            showToast(`Reflector rotated to ${existing.slash ? "/" : "\\"}.`, "");
        } else {
            createMirror(r, c, true);
            showToast("Reflector placed. Tap it again to switch its angle.", "");
        }
        const result = routeBeam();
        if (result.outcome === "win") {
            won = true;
            setStatus("Power restored. The beam has reached the central core.");
            showToast("CORE ONLINE — optical route complete!", "success");
            powerButton.innerHTML = "<span>↻</span> PLAY AGAIN";
        } else {
            setStatus(`${mirrors.size} reflector${mirrors.size === 1 ? "" : "s"} placed · Keep routing the light to the core.`);
        }
    }

    function getTileFromPointer(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        raycaster.setFromCamera(pointer, camera);
        const intersections = raycaster.intersectObjects(tileObjects, false);
        if (!intersections.length) return null;
        return intersections[0].object.userData;
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function resize() {
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.fov = width < 640 ? 63 : 39;
        const compactLayout = width < 640;
        if (lastCompactLayout === null) {
            cameraDistance = compactLayout ? 19.5 : 15.2;
        } else if (compactLayout !== lastCompactLayout) {
            cameraDistance *= compactLayout ? 19.5 / 15.2 : 15.2 / 19.5;
        }
        lastCompactLayout = compactLayout;
        camera.updateProjectionMatrix();
        updateCamera();
    }

    function updateCamera() {
        const target = new THREE.Vector3(0, -.72, 0);
        const horizontal = Math.cos(elevation) * cameraDistance;
        camera.position.set(
            target.x + Math.sin(orbit) * horizontal,
            target.y + Math.sin(elevation) * cameraDistance,
            target.z + Math.cos(orbit) * horizontal
        );
        camera.lookAt(target);
    }

    function resetCamera() {
        orbit = -0.48;
        elevation = 0.76;
        cameraDistance = canvas.clientWidth < 640 ? 19.5 : 15.2;
        updateCamera();
    }

    function changeCamera(horizontal, vertical) {
        orbit += horizontal;
        elevation = THREE.MathUtils.clamp(elevation + vertical, .04, 1.48);
        updateCamera();
    }

    function distanceBetweenPointers() {
        const points = [...activePointers.values()];
        if (points.length < 2) return 0;
        return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    }

    function animate(time = 0) {
        requestAnimationFrame(animate);
        const pulse = .88 + Math.sin(time * .0032) * .12;
        pinkLight.intensity = 14 * pulse;
        coreLight.intensity = won ? 26 * pulse : 16 * pulse;
        rotatingRings.forEach((ring) => {
            ring.rotation.y += ring.userData.spinRate * .008;
        });
        renderer.render(scene, camera);
    }

    function updateSelection() {
        const old = tileMeshes.get(key(selectedCell.r, selectedCell.c));
        if (old && old.material.emissive) old.material.emissive.setHex(0x000000);
        const current = tileMeshes.get(key(selectedCell.r, selectedCell.c));
        if (current) {
            current.material.emissive = new THREE.Color(0x187797);
            current.material.emissiveIntensity = .23;
        }
    }

    function findNextCell(r, c, dr, dc) {
        let nextR = r + dr;
        let nextC = c + dc;
        for (let i = 0; i < ROWS * COLS; i++) {
            if (hasTile(nextR, nextC)) return { r: nextR, c: nextC };
            nextR += dr;
            nextC += dc;
        }
        return { r, c };
    }

    function resetPuzzle() {
        clearGroup(mirrorGroup);
        clearGroup(beamGroup);
        mirrors.clear();
        won = false;
        powerButton.innerHTML = "<span>▶</span> POWER THE CORE";
        setStatus("Tap an open tile to place a mirror. Tap it again to rotate.");
        showToast("Puzzle reset. Route the light to the core.");
        updateSelection();
    }

    canvas.addEventListener("pointerdown", (event) => {
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        canvas.setPointerCapture(event.pointerId);
        if (activePointers.size === 1) {
            dragging = true;
            dragMoved = false;
            pointerX = event.clientX;
            pointerY = event.clientY;
        } else if (activePointers.size === 2) {
            dragging = false;
            dragMoved = true;
            pinchDistance = distanceBetweenPointers();
        }
    });

    canvas.addEventListener("pointermove", (event) => {
        if (!activePointers.has(event.pointerId)) return;
        const previousPointer = activePointers.get(event.pointerId);
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (activePointers.size >= 2) {
            const nextDistance = distanceBetweenPointers();
            if (pinchDistance > 0 && nextDistance > 0) {
                cameraDistance = THREE.MathUtils.clamp(cameraDistance - (nextDistance - pinchDistance) * .035, 10, 28);
                updateCamera();
            }
            pinchDistance = nextDistance;
            return;
        }
        if (!dragging) return;
        const dx = event.clientX - pointerX;
        const dy = event.clientY - pointerY;
        pointerX = event.clientX;
        pointerY = event.clientY;
        if (Math.abs(event.clientX - previousPointer.x) + Math.abs(event.clientY - previousPointer.y) > 2) dragMoved = true;
        if (dragMoved) {
            orbit -= dx * .006;
            elevation = THREE.MathUtils.clamp(elevation + dy * .004, .04, 1.48);
            updateCamera();
            hintEl.textContent = "DRAG TO ORBIT · PINCH / SCROLL TO ZOOM";
        }
    });

    canvas.addEventListener("pointerup", (event) => {
        if (activePointers.size === 1 && !dragMoved) {
            const cell = getTileFromPointer(event);
            if (cell) interactCell(cell.row, cell.col);
        }
        activePointers.delete(event.pointerId);
        dragging = false;
        pinchDistance = activePointers.size >= 2 ? distanceBetweenPointers() : 0;
    });
    canvas.addEventListener("pointercancel", (event) => {
        activePointers.delete(event.pointerId);
        dragging = false;
        pinchDistance = activePointers.size >= 2 ? distanceBetweenPointers() : 0;
    });
    canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        cameraDistance = THREE.MathUtils.clamp(cameraDistance + event.deltaY * .009, 10, 28);
        updateCamera();
    }, { passive: false });

    canvas.addEventListener("keydown", (event) => {
        let next = selectedCell;
        if (event.key === "ArrowUp") next = findNextCell(next.r, next.c, -1, 0);
        else if (event.key === "ArrowDown") next = findNextCell(next.r, next.c, 1, 0);
        else if (event.key === "ArrowLeft") next = findNextCell(next.r, next.c, 0, -1);
        else if (event.key === "ArrowRight") next = findNextCell(next.r, next.c, 0, 1);
        else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            interactCell(selectedCell.r, selectedCell.c);
            return;
        } else return;
        event.preventDefault();
        selectedCell = next;
        updateSelection();
    });

    powerButton.addEventListener("click", () => {
        if (won) {
            resetPuzzle();
            return;
        }
        const result = routeBeam();
        if (result.outcome === "win") {
            won = true;
            setStatus("Power restored. The beam has reached the central core.");
            showToast("CORE ONLINE — optical route complete!", "success");
            powerButton.innerHTML = "<span>↻</span> PLAY AGAIN";
        } else if (result.outcome === "blocked") {
            setStatus("The beam hit a stone blocker. Move or rotate a reflector to find another route.");
            showToast("Beam intercepted by a stone blocker.", "error");
        } else if (result.outcome === "loop") {
            setStatus("The beam is looping. Rotate a reflector to redirect it.");
            showToast("Reflection loop — adjust a reflector.", "error");
        } else {
            setStatus("The beam misses the core. Place or rotate a reflector to guide it.");
            showToast("No connection yet. Adjust the light path.", "error");
        }
    });

    resetButton.addEventListener("click", resetPuzzle);
    cameraLeftButton.addEventListener("click", () => changeCamera(-Math.PI / 8, 0));
    cameraRightButton.addEventListener("click", () => changeCamera(Math.PI / 8, 0));
    cameraUpButton.addEventListener("click", () => changeCamera(0, -.12));
    cameraDownButton.addEventListener("click", () => changeCamera(0, .12));
    cameraResetButton.addEventListener("click", resetCamera);

    makeBackdrop();
    makePlatformBase();
    makeTiles();
    makeBlockers();
    makeArchitecture();
    makeCrystals();
    makeCore();
    resize();
    updateSelection();
    routeBeam();
    animate();
    window.addEventListener("resize", resize);
})();
