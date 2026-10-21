import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { levels, calculateSolveTimeMilliseconds, evaluateLevelStars } from "./levels.js";

const canvas = document.getElementById("scene-canvas");
const errorPanel = document.getElementById("load-error");
const statusTitle = document.getElementById("game-status-title");
const statusText = document.getElementById("game-status");
const traceButton = document.getElementById("trace-beam");
const resetButton = document.getElementById("reset-game");
const completionSummary = document.getElementById("completion-summary");
const gameHud = document.querySelector(".game-hud");
const colors = {
    pink: 0xff77e6,
    amber: 0xffaa43,
    blue: 0x43baff,
    cold: 0x75dcff
};

try {
    startScene();
} catch (error) {
    console.error("Unable to initialize the 3D scene.", error);
    errorPanel.textContent = "The 3D scene could not start. Check that your browser supports WebGL and that the Three.js files are reachable.";
    errorPanel.hidden = false;
}

function startScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080d);
    scene.fog = new THREE.FogExp2(0x05080d, 0.014);

    const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 160);
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: "high-performance"
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
    renderer.shadowMap.enabled = window.innerWidth >= 620;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.12, 0.34, 1.02);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    scene.add(new THREE.HemisphereLight(0x899bb4, 0x21150f, 1.5));

    const moonLight = new THREE.DirectionalLight(0xb5c6dc, 4);
    moonLight.position.set(-7, 15, -4);
    moonLight.castShadow = window.innerWidth >= 620;
    moonLight.shadow.mapSize.set(1024, 1024);
    moonLight.shadow.camera.left = -14;
    moonLight.shadow.camera.right = 14;
    moonLight.shadow.camera.top = 14;
    moonLight.shadow.camera.bottom = -14;
    moonLight.shadow.bias = -0.00035;
    scene.add(moonLight);

    const warmLight = new THREE.PointLight(0xff7134, 17, 12, 2);
    warmLight.position.set(-3.8, 2.7, 1.7);
    scene.add(warmLight);
    const magentaLight = new THREE.PointLight(colors.pink, 10, 9, 2);
    magentaLight.position.set(-4.7, 1.5, -1.5);
    scene.add(magentaLight);
    const blueLight = new THREE.PointLight(colors.blue, 15, 12, 2);
    blueLight.position.set(3.4, 2.2, 2.7);
    scene.add(blueLight);
    const coreLight = new THREE.PointLight(colors.cold, 8, 8, 2);
    coreLight.position.set(1.35, 1.5, 0.1);
    scene.add(coreLight);

    const world = new THREE.Group();
    scene.add(world);
    const platform = new THREE.Group();
    world.add(platform);
    const environmentNetwork = new THREE.Group();
    platform.add(environmentNetwork);
    const interactionGroup = new THREE.Group();
    platform.add(interactionGroup);
    const levelObjectGroup = new THREE.Group();
    platform.add(levelObjectGroup);
    const mirrorGroup = new THREE.Group();
    platform.add(mirrorGroup);
    const activeBeamGroup = new THREE.Group();
    platform.add(activeBeamGroup);

    const GRID = {
        rows: 6,
        cols: 8,
        step: 1.4,
        x0: -5.6,
        z0: -3.8,
        start: { row: 0, col: 2 },
        target: { row: 3, col: 5 }
    };
    const gridKey = (row, col) => `${row},${col}`;
    const gridX = (col) => GRID.x0 + col * GRID.step;
    const gridZ = (row) => GRID.z0 + row * GRID.step;
    const tileTargets = [];
    const sourceTargets = [];
    const placedMirrors = new Map();
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const beamSegments = [];
    const animatedObjects = [];
    let activeLevel = levels[0];
    let previewRoute = null;
    let sourcePylon = null;
    let sourceMarkerGroup = null;
    let sourceHitArea = null;
    let coreSystem = null;
    let corePulse = null;
    let corePowered = false;
    let tracing = false;
    let launchDirection = 1;
    let walletLevelSessionId = null;
    let updateSourceMarker = () => {};
    let traceStartedAt = 0;
    let levelStartedAt = null;
    let traceResult = null;

    const cameraState = {
        azimuth: 0.53,
        elevation: 0.54,
        distance: 12.5,
        defaultAzimuth: 0.53,
        defaultElevation: 0.54,
        dragging: false,
        moved: false,
        lastX: 0,
        lastY: 0,
        pointers: new Map(),
        pinchDistance: 0
    };

    const makeMaterial = (color, roughness = 0.8, metalness = 0.1, extra = {}) =>
        new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

    function createStoneMaps() {
        const size = 512;
        const colorCanvas = document.createElement("canvas");
        const heightCanvas = document.createElement("canvas");
        colorCanvas.width = colorCanvas.height = size;
        heightCanvas.width = heightCanvas.height = size;
        const colorContext = colorCanvas.getContext("2d");
        const heightContext = heightCanvas.getContext("2d");
        const colorImage = colorContext.createImageData(size, size);
        const heightImage = heightContext.createImageData(size, size);
        let seed = 92831;
        const random = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        const cloudCanvas = document.createElement("canvas");
        cloudCanvas.width = cloudCanvas.height = 64;
        const cloudContext = cloudCanvas.getContext("2d");
        const cloudImage = cloudContext.createImageData(64, 64);
        for (let i = 0; i < cloudImage.data.length; i += 4) {
            const shade = 82 + Math.floor(random() * 94);
            cloudImage.data[i] = shade;
            cloudImage.data[i + 1] = shade;
            cloudImage.data[i + 2] = shade;
            cloudImage.data[i + 3] = 255;
        }
        cloudContext.putImageData(cloudImage, 0, 0);
        colorContext.imageSmoothingEnabled = true;
        colorContext.drawImage(cloudCanvas, 0, 0, size, size);
        const cloudField = colorContext.getImageData(0, 0, size, size).data;

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const index = (y * size + x) * 4;
                const cloud = cloudField[index] - 128;
                const grain = (random() - 0.5) * 18;
                const strata = Math.sin(x * 0.035 + Math.sin(y * 0.018) * 2.2) * 9;
                const fleck = Math.sin(x * 0.19 + y * 0.11) * Math.cos(y * 0.16 - x * 0.05) * 8;
                const shade = Math.max(0, Math.min(255, 119 + cloud * 0.42 + grain + strata + fleck));
                colorImage.data[index] = shade * 1.04;
                colorImage.data[index + 1] = shade;
                colorImage.data[index + 2] = shade * 0.91;
                colorImage.data[index + 3] = 255;
                const relief = Math.max(0, Math.min(255, 150 + cloud * 0.65 + grain * 1.6 + strata * 1.8 + fleck));
                heightImage.data[index] = relief;
                heightImage.data[index + 1] = relief;
                heightImage.data[index + 2] = relief;
                heightImage.data[index + 3] = 255;
            }
        }
        colorContext.putImageData(colorImage, 0, 0);
        heightContext.putImageData(heightImage, 0, 0);

        for (let i = 0; i < 38; i++) {
            const x = random() * size;
            const y = random() * size;
            const radius = 4 + random() * 25;
            const shade = 77 + Math.floor(random() * 84);
            colorContext.fillStyle = `rgba(${shade},${shade * 0.98},${shade * 0.9},${0.025 + random() * 0.06})`;
            colorContext.beginPath();
            colorContext.ellipse(x, y, radius * (0.6 + random()), radius * (0.3 + random() * 0.4), random() * Math.PI, 0, Math.PI * 2);
            colorContext.fill();
        }

        for (let i = 0; i < 15; i++) {
            let x = random() * size;
            let y = random() * size;
            const steps = 4 + Math.floor(random() * 7);
            colorContext.beginPath();
            heightContext.beginPath();
            colorContext.moveTo(x, y);
            heightContext.moveTo(x, y);
            for (let step = 0; step < steps; step++) {
                x += (random() - 0.5) * 56;
                y += (random() - 0.5) * 56;
                colorContext.lineTo(x, y);
                heightContext.lineTo(x, y);
            }
            colorContext.strokeStyle = "rgba(32,30,27,0.72)";
            colorContext.lineWidth = 0.7 + random() * 1.2;
            colorContext.stroke();
            heightContext.strokeStyle = "rgba(45,45,45,0.9)";
            heightContext.lineWidth = 2.4;
            heightContext.stroke();
            colorContext.strokeStyle = "rgba(215,202,178,0.24)";
            colorContext.lineWidth = 0.7;
            colorContext.stroke();
            heightContext.strokeStyle = "rgba(225,225,225,0.46)";
            heightContext.lineWidth = 1;
            heightContext.stroke();
        }

        const colorMap = new THREE.CanvasTexture(colorCanvas);
        colorMap.colorSpace = THREE.SRGBColorSpace;
        colorMap.wrapS = colorMap.wrapT = THREE.RepeatWrapping;
        const heightMap = new THREE.CanvasTexture(heightCanvas);
        heightMap.wrapS = heightMap.wrapT = THREE.RepeatWrapping;
        return { colorMap, heightMap };
    }

    const stoneMaps = createStoneMaps();
    const makeStoneMaterial = (color, repeatX = 1, repeatY = 1, extra = {}) => {
        const map = stoneMaps.colorMap.clone();
        map.repeat.set(repeatX, repeatY);
        map.needsUpdate = true;
        const bumpMap = stoneMaps.heightMap.clone();
        bumpMap.repeat.set(repeatX, repeatY);
        bumpMap.needsUpdate = true;
        return makeMaterial(color, 0.96, 0.015, {
            map,
            bumpMap,
            bumpScale: 0.11,
            ...extra
        });
    };

    const materials = {
        platform: makeStoneMaterial(0xaaa49a, 2.8, 2.3),
        platformSide: makeStoneMaterial(0x615e59, 2.1, 1.2),
        underside: makeStoneMaterial(0x696c70, 2.2, 1.1),
        floor: [
            makeStoneMaterial(0x92877b, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0xa09485, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0x8d9291, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0xa28f7c, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0x898d91, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0x978d84, 1.15, 1.15, { side: THREE.DoubleSide })
        ],
        seam: new THREE.MeshBasicMaterial({ color: 0x151311 }),
        metal: makeMaterial(0x202a34, 0.46, 0.78),
        metalEdge: makeMaterial(0x4b5560, 0.4, 0.82),
        column: makeStoneMaterial(0x818487, 1.3, 3.4),
        columnLight: makeStoneMaterial(0xa09a8d, 1.5, 2.2),
        stone: [
            makeStoneMaterial(0x89837b, 0.95, 0.95),
            makeStoneMaterial(0x9a9185, 0.95, 0.95),
            makeStoneMaterial(0x858b8b, 0.95, 0.95)
        ],
        crack: new THREE.LineBasicMaterial({ color: 0x191918, transparent: true, opacity: 0.86 }),
        circuit: new THREE.MeshStandardMaterial({
            color: 0xffa6ef,
            emissive: 0xff43d9,
            emissiveIntensity: 2.1,
            metalness: 0.25,
            roughness: 0.35
        })
    };

    const addBox = (parent, size, position, material, options = {}) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
        mesh.position.set(...position);
        mesh.castShadow = options.castShadow !== false;
        mesh.receiveShadow = options.receiveShadow !== false;
        if (options.rotation) mesh.rotation.set(...options.rotation);
        parent.add(mesh);
        return mesh;
    };

    const addCylinder = (parent, top, bottom, height, position, material, segments = 12) => {
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(top, bottom, height, segments),
            material
        );
        mesh.position.set(...position);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
        return mesh;
    };

    const extrudedPolygon = (parent, points, depth, y, material, bevel = 0) => {
        const shape = new THREE.Shape();
        shape.moveTo(points[0][0], -points[0][1]);
        for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], -points[i][1]);
        shape.closePath();
        const geometry = new THREE.ExtrudeGeometry(shape, {
            depth,
            bevelEnabled: bevel > 0,
            bevelSegments: bevel > 0 ? 2 : 0,
            bevelSize: bevel,
            bevelThickness: bevel,
            curveSegments: 1
        });
        geometry.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.y = y;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
        return mesh;
    };

    function createVoid() {
        const floor = new THREE.Mesh(
            new THREE.PlaneGeometry(180, 180),
            makeMaterial(0x05080d, 1, 0.04)
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -3.5;
        floor.receiveShadow = true;
        scene.add(floor);

        const dustPositions = [];
        let seed = 7812;
        const random = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        for (let i = 0; i < 650; i++) {
            dustPositions.push(
                (random() - 0.5) * 90,
                random() * 28 - 2,
                (random() - 0.5) * 90
            );
        }
        const dustGeometry = new THREE.BufferGeometry();
        dustGeometry.setAttribute("position", new THREE.Float32BufferAttribute(dustPositions, 3));
        scene.add(new THREE.Points(
            dustGeometry,
            new THREE.PointsMaterial({ color: 0x9baec0, size: 0.025, transparent: true, opacity: 0.52 })
        ));
    }

    function createFloatingPlatform() {
        const outline = [
            [-7.05, -3.45], [-6.05, -4.75], [-4.6, -4.8], [-3.65, -5.25],
            [-1.65, -5.08], [-0.8, -4.5], [1.7, -4.72], [2.7, -4.18],
            [4.85, -4.02], [5.65, -3.14], [5.45, -2.1], [6.3, -1.24],
            [5.95, 0.25], [6.55, 1.18], [5.85, 2.35], [5.05, 2.68],
            [4.7, 4.08], [3.42, 4.18], [2.62, 4.96], [0.9, 4.7],
            [-0.1, 5.15], [-2.25, 4.66], [-3.02, 4.05], [-5.68, 4.12],
            [-6.68, 3.03], [-6.35, 1.92], [-7.12, 0.94], [-6.68, -0.42],
            [-7.28, -1.46]
        ];
        extrudedPolygon(platform, outline, 1.05, -0.97, materials.platform, 0.12);

        const lowerOutline = outline.map(([x, z]) => [x * 0.93, z * 0.93]);
        extrudedPolygon(platform, lowerOutline, 0.4, -1.9, materials.underside, 0.08);

        const edgeBand = makeMaterial(0x35414b, 0.46, 0.76);
        const brokenSupports = [
            [-5.6, 0.6, 0.95, 0.44, 0.65],
            [-3.8, 3.4, 1.1, 0.48, 0.7],
            [-1.5, 4.3, 1.4, 0.42, 0.8],
            [3.1, 3.95, 1.25, 0.45, 0.65],
            [5.0, 1.65, 0.9, 0.5, 0.75],
            [4.2, -3.55, 1.4, 0.45, 0.85],
            [-4.6, -3.95, 1.1, 0.4, 0.7]
        ];
        brokenSupports.forEach(([x, z, w, h, d], i) => {
            const tooth = addBox(platform, [w, h, d], [x, -1.58, z], i % 2 ? edgeBand : materials.underside);
            tooth.rotation.y = (i % 2 ? 1 : -1) * 0.12;
        });

        const rimPoints = [
            [[-6.4, -4.3], [-4.7, -4.65]],
            [[-3.5, -4.78], [-1.75, -4.72]],
            [[2.85, -3.96], [4.65, -3.78]],
            [[5.62, -1.9], [5.75, -0.1]],
            [[5.33, 2.46], [4.52, 3.78]],
            [[2.58, 4.45], [1.0, 4.35]],
            [[-0.5, 4.72], [-2.05, 4.25]],
            [[-5.55, 3.72], [-6.18, 2.85]]
        ];
        rimPoints.forEach((edge) => {
            const points = edge.map(([x, z]) => new THREE.Vector3(x, -0.11, z));
            const mesh = new THREE.Mesh(
                new THREE.TubeGeometry(new THREE.LineCurve3(points[0], points[1]), 1, 0.035, 5, false),
                new THREE.MeshStandardMaterial({ color: 0x56616a, metalness: 0.72, roughness: 0.38 })
            );
            platform.add(mesh);
        });

        const underglow = new THREE.PointLight(0x274867, 20, 14, 2);
        underglow.position.set(0, -1.8, 0);
        platform.add(underglow);
        createFracturedFloor();
    }

    function createFracturedFloor() {
        const cols = 8;
        const rows = 6;
        const left = -6.45;
        const right = 5.45;
        const back = -4.3;
        const front = 4.25;
        const dx = (right - left) / cols;
        const dz = (front - back) / rows;
        let seed = 4039;
        const random = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        const vertices = [];

        for (let r = 0; r <= rows; r++) {
            vertices[r] = [];
            for (let c = 0; c <= cols; c++) {
                const border = r === 0 || r === rows || c === 0 || c === cols;
                vertices[r][c] = [
                    left + c * dx + (border ? 0 : (random() - 0.5) * dx * 0.26),
                    back + r * dz + (border ? 0 : (random() - 0.5) * dz * 0.3)
                ];
            }
        }

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const cx = left + (c + 0.5) * dx;
                const cz = back + (r + 0.5) * dz;
                const coreDistance = Math.hypot(cx - 1.35, cz - 0.1);
                if (coreDistance < 1.5 || random() < 0.035) continue;

                const quad = [
                    vertices[r][c], vertices[r][c + 1],
                    vertices[r + 1][c + 1], vertices[r + 1][c]
                ];
                const shrink = 0.035 + random() * 0.025;
                const plate = quad.map(([x, z]) => [
                    cx + (x - cx) * (1 - shrink),
                    cz + (z - cz) * (1 - shrink)
                ]);
                const floorMaterial = materials.floor[Math.floor(random() * materials.floor.length)];
                const tile = extrudedPolygon(
                    platform,
                    plate,
                    0.16 + random() * 0.045,
                    -0.06,
                    floorMaterial,
                    0.025
                );
                tile.position.y += (random() - 0.5) * 0.07;

                const topShape = new THREE.Shape();
                topShape.moveTo(plate[0][0], -plate[0][1]);
                for (let i = 1; i < plate.length; i++) topShape.lineTo(plate[i][0], -plate[i][1]);
                topShape.closePath();
                const topFace = new THREE.Mesh(
                    new THREE.ShapeGeometry(topShape),
                    floorMaterial.clone()
                );
                topFace.geometry.rotateX(-Math.PI / 2);
                topFace.position.y = 0.145 + (random() - 0.5) * 0.018;
                topFace.receiveShadow = true;
                platform.add(topFace);

                for (let i = 0; i < plate.length; i++) {
                    const a = plate[i];
                    const b = plate[(i + 1) % plate.length];
                    const edge = new THREE.LineCurve3(
                        new THREE.Vector3(a[0], 0.145, a[1]),
                        new THREE.Vector3(b[0], 0.145, b[1])
                    );
                    platform.add(new THREE.Mesh(
                        new THREE.TubeGeometry(edge, 1, 0.026, 5, false),
                        materials.seam
                    ));
                }
            }
        }

        createCracks();
        createLooseSlabs();
    }

    function createCracks() {
        const paths = [
            [[-5.8, -2.9], [-5.32, -2.62], [-5.03, -2.15], [-4.54, -2.01]],
            [[-5.03, -2.15], [-5.22, -1.71], [-4.93, -1.34]],
            [[-4.9, 0.3], [-4.41, 0.12], [-4.12, -0.27], [-3.72, -0.44]],
            [[-4.12, -0.27], [-3.96, -0.75], [-3.61, -0.98]],
            [[-5.45, 2.1], [-4.93, 2.31], [-4.65, 2.77], [-4.13, 2.94]],
            [[-4.65, 2.77], [-4.91, 3.15]],
            [[-3.25, -3.5], [-2.85, -3.15], [-2.77, -2.64], [-2.31, -2.43]],
            [[-2.77, -2.64], [-3.21, -2.32]],
            [[-2.55, 0.06], [-2.06, 0.28], [-1.82, 0.76], [-1.31, 0.86]],
            [[-1.82, 0.76], [-2.12, 1.2]],
            [[-2.88, 2.13], [-2.39, 1.95], [-2.1, 1.48]],
            [[-0.55, -3.5], [-0.22, -3.03], [0.25, -2.91], [0.51, -2.42]],
            [[-0.22, -3.03], [-0.71, -2.78]],
            [[-0.75, 1.88], [-0.35, 1.62], [-0.16, 1.14], [0.33, 0.95]],
            [[-0.16, 1.14], [-0.49, 0.74]],
            [[-1.05, 3.24], [-0.6, 2.94], [-0.44, 2.48]],
            [[2.7, -3.42], [3.14, -3.11], [3.28, -2.64], [3.76, -2.39]],
            [[3.28, -2.64], [2.91, -2.19]],
            [[4.15, -0.65], [4.5, -0.26], [4.4, 0.18], [4.87, 0.48]],
            [[4.4, 0.18], [4.06, 0.59]],
            [[3.62, 2.68], [3.96, 2.28], [4.43, 2.18], [4.74, 1.79]],
            [[-3.66, 3.7], [-3.28, 3.43], [-3.16, 3.02]]
        ];
        paths.forEach((path) => {
            for (let i = 0; i < path.length - 1; i++) {
                const [x1, z1] = path[i];
                const [x2, z2] = path[i + 1];
                const line = new THREE.LineCurve3(
                    new THREE.Vector3(x1, 0.195, z1),
                    new THREE.Vector3(x2, 0.195, z2)
                );
                platform.add(new THREE.Mesh(
                    new THREE.TubeGeometry(line, 1, 0.012, 4, false),
                    materials.seam
                ));
            }
        });

        const seamMat = new THREE.MeshBasicMaterial({ color: 0x252321 });
        [
            [[-6.2, -1.0], [-5.75, -0.95], [-5.48, -0.52]],
            [[-3.7, 1.2], [-3.33, 1.02], [-3.11, 0.58]],
            [[-1.1, -1.6], [-0.75, -1.83], [-0.26, -1.8]],
            [[0.12, 2.8], [0.55, 2.65], [0.75, 2.2]],
            [[2.72, 1.8], [3.15, 1.63], [3.5, 1.82]],
            [[4.8, -2.52], [4.38, -2.21], [4.15, -1.79]]
        ].forEach((path) => {
            for (let i = 0; i < path.length - 1; i++) {
                const [x1, z1] = path[i];
                const [x2, z2] = path[i + 1];
                const line = new THREE.LineCurve3(
                    new THREE.Vector3(x1, 0.19, z1),
                    new THREE.Vector3(x2, 0.19, z2)
                );
                platform.add(new THREE.Mesh(
                    new THREE.TubeGeometry(line, 1, 0.014, 4, false),
                    seamMat
                ));
            }
        });
    }

    function createGameplaySurface() {
        const targetMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            colorWrite: false,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        const targetGeometry = new THREE.PlaneGeometry(GRID.step * 0.96, GRID.step * 0.96);

        for (let row = 0; row < GRID.rows; row++) {
            for (let col = 0; col < GRID.cols; col++) {
                const target = new THREE.Mesh(targetGeometry, targetMaterial);
                target.rotation.x = -Math.PI / 2;
                target.position.set(gridX(col), 0.235, gridZ(row));
                target.userData.row = row;
                target.userData.col = col;
                target.userData.cellKey = gridKey(row, col);
                interactionGroup.add(target);
                tileTargets.push(target);
            }
        }

        const hoverRing = new THREE.Mesh(
            new THREE.TorusGeometry(0.42, 0.022, 6, 32),
            new THREE.MeshBasicMaterial({
                color: 0x9befff,
                transparent: true,
                opacity: 0.76,
                toneMapped: false,
                depthWrite: false
            })
        );
        hoverRing.rotation.x = Math.PI / 2;
        hoverRing.position.y = 0.27;
        hoverRing.visible = false;
        interactionGroup.add(hoverRing);
        updateSourceMarker = createSourceMarker();
        return hoverRing;
    }

    function createSourceMarker() {
        const marker = new THREE.Group();
        platform.add(marker);
        sourceMarkerGroup = marker;

        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.48, 0.025, 6, 40),
            new THREE.MeshBasicMaterial({
                color: 0xffa0ed,
                transparent: true,
                opacity: 0.82,
                toneMapped: false,
                depthWrite: false
            })
        );
        ring.rotation.x = Math.PI / 2;
        marker.add(ring);

        const arrows = [-1, 1].map((direction) => {
            const arrow = new THREE.Mesh(
                new THREE.ConeGeometry(0.13, 0.3, 3),
                new THREE.MeshBasicMaterial({
                    color: 0x744d78,
                    transparent: true,
                    opacity: 0.6,
                    toneMapped: false,
                    depthWrite: false
                })
            );
            arrow.rotation.z = direction < 0 ? Math.PI / 2 : -Math.PI / 2;
            arrow.position.set(direction * 0.31, 0.035, 0);
            marker.add(arrow);
            return arrow;
        });

        const hitArea = new THREE.Mesh(
            new THREE.PlaneGeometry(1.05, 1.05),
            new THREE.MeshBasicMaterial({
                transparent: true,
                opacity: 0,
                colorWrite: false,
                depthWrite: false,
                side: THREE.DoubleSide
            })
        );
        hitArea.rotation.x = -Math.PI / 2;
        hitArea.position.set(0, 0.29, 0);
        interactionGroup.add(hitArea);
        sourceHitArea = hitArea;
        sourceTargets.push(hitArea);

        const update = () => {
            const x = gridX(GRID.start.col);
            const z = gridZ(GRID.start.row);
            marker.position.set(x, 0.25, z);
            hitArea.position.set(x, 0.29, z);
            sourcePylon?.position.set(x, 0.05, z);
            arrows.forEach((arrow, index) => {
                const isSelected = (index === 1) === (launchDirection === 1);
                arrow.material.color.setHex(isSelected ? 0xffb8f0 : 0x744d78);
                arrow.material.opacity = isSelected ? 1 : 0.48;
                arrow.scale.setScalar(isSelected ? 1.2 : 0.84);
            });
        };
        update();
        return update;
    }

    function createSquarePlacementGrid() {
        const grid = new THREE.Group();
        const lineMaterial = makeMaterial(0x46535d, 0.82, 0.24);
        const lineWidth = 0.02;
        const lineHeight = 0.012;
        const left = gridX(0) - GRID.step / 2;
        const right = gridX(GRID.cols - 1) + GRID.step / 2;
        const back = gridZ(0) - GRID.step / 2;
        const front = gridZ(GRID.rows - 1) + GRID.step / 2;
        const y = 0.205;

        for (let col = 0; col <= GRID.cols; col++) {
            const x = left + col * GRID.step;
            addBox(
                grid,
                [lineWidth, lineHeight, front - back],
                [x, y, (back + front) / 2],
                lineMaterial,
                { castShadow: false, receiveShadow: false }
            );
        }

        for (let row = 0; row <= GRID.rows; row++) {
            const z = back + row * GRID.step;
            addBox(
                grid,
                [right - left, lineHeight, lineWidth],
                [(left + right) / 2, y, z],
                lineMaterial,
                { castShadow: false, receiveShadow: false }
            );
        }

        platform.add(grid);
    }

    function createPlayerMirror(row, col, slash = true) {
        const group = new THREE.Group();
        const obstacleIndex = activeLevel.obstacles.findIndex(
            (cell) => cell.row === row && cell.col === col
        );
        const obstacleTop = obstacleIndex < 0
            ? 0.2
            : 0.19 + 0.52 + (obstacleIndex % 2) * 0.16 + 0.06;
        group.position.set(gridX(col), obstacleTop, gridZ(row));
        const baseMaterial = makeMaterial(0x26313d, 0.38, 0.82);
        const frameMaterial = makeMaterial(0x778995, 0.31, 0.8);
        const glassMaterial = new THREE.MeshStandardMaterial({
            color: 0x79e6fa,
            emissive: 0x168db6,
            emissiveIntensity: 0.65,
            metalness: 0.56,
            roughness: 0.17,
            transparent: true,
            opacity: 0.88,
            side: THREE.DoubleSide
        });

        addBox(group, [0.72, 0.1, 0.54], [0, 0.07, 0], baseMaterial);
        addBox(group, [0.54, 0.055, 0.39], [0, 0.145, 0], frameMaterial);
        const panel = new THREE.Group();
        panel.position.y = 0.58;
        group.add(panel);
        addBox(panel, [0.62, 0.72, 0.085], [0, 0, 0], frameMaterial);
        addBox(panel, [0.49, 0.59, 0.035], [0, 0, 0.058], glassMaterial, { castShadow: false });
        addBox(panel, [0.68, 0.065, 0.12], [0, 0.37, 0], frameMaterial);
        addBox(panel, [0.075, 0.75, 0.12], [-0.31, 0, 0], frameMaterial);
        addBox(panel, [0.075, 0.75, 0.12], [0.31, 0, 0], frameMaterial);

        const mount = new THREE.PointLight(0x42d7ff, 2, 1.4, 2);
        mount.position.set(0, 0.35, 0);
        group.add(mount);

        const mirror = { row, col, slash, group, panel };
        orientMirror(mirror);
        mirrorGroup.add(group);
        placedMirrors.set(gridKey(row, col), mirror);
        return mirror;
    }

    function orientMirror(mirror) {
        mirror.panel.rotation.y = mirror.slash ? -Math.PI / 4 : Math.PI / 4;
    }

    function clearObjectGroup(group) {
        for (let i = group.children.length - 1; i >= 0; i--) {
            const child = group.children[i];
            group.remove(child);
            child.traverse((object) => {
                if (!object.isMesh && !object.isLine) return;
                object.geometry?.dispose();
                if (Array.isArray(object.material)) {
                    object.material.forEach((material) => material.dispose());
                } else {
                    object.material?.dispose();
                }
            });
        }
    }

    const directions = [
        { row: -1, col: 0 },
        { row: 0, col: 1 },
        { row: 1, col: 0 },
        { row: 0, col: -1 }
    ];
    const slashReflection = [1, 0, 3, 2];
    const backslashReflection = [3, 2, 1, 0];
    const beamColors = [colors.pink, colors.amber, colors.blue];

    function traceLight() {
        let row = GRID.start.row;
        let col = GRID.start.col;
        let direction = launchDirection;
        let colorIndex = 0;
        const segments = [];
        const visited = new Set();
        let outcome = "edge";
        let reflections = 0;
        let finalCell = { row, col };
        let         from = new THREE.Vector3(gridX(GRID.start.col), 0.82, gridZ(GRID.start.row));

        for (let step = 0; step < GRID.rows * GRID.cols * 2; step++) {
            const state = `${row},${col},${direction}`;
            if (visited.has(state)) {
                outcome = "loop";
                break;
            }
            visited.add(state);

            const nextRow = row + directions[direction].row;
            const nextCol = col + directions[direction].col;
            if (nextRow < 0 || nextRow >= GRID.rows || nextCol < 0 || nextCol >= GRID.cols) {
                outcome = "edge";
                finalCell = { row, col };
                const directionVector = directions[direction];
                const exit = from.clone().add(new THREE.Vector3(
                    directionVector.col,
                    0,
                    directionVector.row
                ).multiplyScalar(GRID.step * 0.68));
                segments.push({ from: from.clone(), to: exit, color: beamColors[colorIndex % beamColors.length] });
                break;
            }

            row = nextRow;
            col = nextCol;
            finalCell = { row, col };
            const isTarget = row === GRID.target.row && col === GRID.target.col;
            const mirror = placedMirrors.get(gridKey(row, col));
            const isObstacle = activeLevel.obstacles.some((cell) => cell.row === row && cell.col === col);
            const to = isTarget
                ? new THREE.Vector3(gridX(col), 1.17, gridZ(row))
                : new THREE.Vector3(gridX(col), 0.72, gridZ(row));
            segments.push({ from: from.clone(), to, color: beamColors[colorIndex % beamColors.length] });
            from = to.clone();

            if (isTarget) {
                outcome = "powered";
                break;
            }
            if (mirror) {
                direction = mirror.slash
                    ? slashReflection[direction]
                    : backslashReflection[direction];
                reflections++;
                colorIndex++;
            } else if (isObstacle) {
                outcome = "blocked";
                break;
            }
        }

        if (outcome === "powered" && reflections < activeLevel.par) {
            outcome = "underpowered";
        }
        return { outcome, finalCell, segments, reflections };
    }

    function addActiveSegment(segment, index, visibleCount) {
        const curve = new THREE.LineCurve3(segment.from, segment.to);
        const glow = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 1, 0.055, 8, false),
            new THREE.MeshBasicMaterial({
                color: segment.color,
                transparent: true,
                opacity: 0.12,
                depthWrite: false,
                toneMapped: false,
                blending: THREE.AdditiveBlending
            })
        );
        const core = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 1, 0.018, 6, false),
            new THREE.MeshBasicMaterial({
                color: segment.color,
                toneMapped: false,
                blending: THREE.AdditiveBlending
            })
        );
        glow.visible = index < visibleCount;
        core.visible = index < visibleCount;
        activeBeamGroup.add(glow, core);
        beamSegments.push({ glow, core });
    }

    function drawActiveRoute(route, visibleCount = route.segments.length) {
        clearObjectGroup(activeBeamGroup);
        beamSegments.length = 0;
        route.segments.forEach((segment, index) => addActiveSegment(segment, index, visibleCount));
    }

    function placeLevelTarget() {
        coreSystem.position.set(
            gridX(GRID.target.col) - 1.35,
            0,
            gridZ(GRID.target.row) - 0.1
        );
        coreLight.position.set(gridX(GRID.target.col), 1.5, gridZ(GRID.target.row));
    }

    function createLevelObstacles() {
        clearObjectGroup(levelObjectGroup);
        activeLevel.obstacles.forEach(({ row, col }, index) => {
            const block = new THREE.Group();
            block.position.set(gridX(col), 0.19, gridZ(row));
            levelObjectGroup.add(block);
            const width = index % 3 === 0 ? 0.92 : 0.76;
            addBox(
                block,
                [width, 0.48 + (index % 2) * 0.16, width * 0.82],
                [0, 0.25, 0],
                materials.stone[index % materials.stone.length]
            );
            addBox(
                block,
                [width + 0.12, 0.08, width * 0.9],
                [0, 0.52 + (index % 2) * 0.16, 0],
                materials.stone[(index + 1) % materials.stone.length]
            );
        });
    }

    function loadLevel(levelDetails) {
        const level = levelDetails?.level ?? levelDetails;
        if (!level || !Number.isInteger(level.number) || level.number < 1 || level.number > levels.length) {
            console.error("Cannot load an invalid FluxGrid level.", level);
            return;
        }
        activeLevel = level;
        walletLevelSessionId = levelDetails?.level ? levelDetails.walletSessionId ?? null : null;
        GRID.start = { row: level.start.row, col: level.start.col };
        GRID.target = { row: level.target.row, col: level.target.col };
        launchDirection = level.start.direction;
        placeLevelTarget();
        createLevelObstacles();
        resetGame();
        updateSourceMarker();
        environmentNetwork.visible = false;
        statusTitle.textContent = `Level ${String(level.number).padStart(2, "0")} — ${level.title}`;
    }

    function setCorePowered(powered) {
        corePowered = powered;
        if (corePulse) {
            corePulse.material.emissive.setHex(powered ? 0x7deeff : 0x1287aa);
            corePulse.material.emissiveIntensity = powered ? 1.2 : 0.32;
            corePulse.material.color.setHex(powered ? 0xc2fbff : 0x317b94);
        }
        if (sourcePylon?.userData.beaconLight) {
            sourcePylon.userData.beaconLight.intensity = powered ? 10 : 7;
        }
    }

    function setStatus(title, message, kind = "") {
        statusTitle.textContent = title;
        statusText.textContent = message;
        statusText.dataset.state = kind;
    }

    function setFeedback(message, kind = "") {
        statusText.textContent = message;
        statusText.dataset.state = kind;
    }

    function startSolveTimer() {
        if (levelStartedAt === null) {
            levelStartedAt = performance.now();
            if (walletLevelSessionId) {
                window.dispatchEvent(new CustomEvent("fluxgrid:level-timer-start", {
                    detail: { walletSessionId: walletLevelSessionId }
                }));
            }
        }
    }

    function showCompletionSummary(level, elapsedMilliseconds, result) {
        const timeTargets = level.starTimeTargets;
        const stars = result.stars;
        document.getElementById("completion-stars").textContent = `${stars} / 3`;
        document.getElementById("completion-star-icons").textContent = `${"★".repeat(stars)}${"☆".repeat(3 - stars)}`;
        document.getElementById("completion-time").textContent = `${(elapsedMilliseconds / 1000).toFixed(1)} s`;
        document.getElementById("completion-time-thresholds").textContent =
            `3★ ≤ ${timeTargets.threeSeconds}s · 2★ ≤ ${timeTargets.twoSeconds}s`;
        document.getElementById("completion-entry-cost").textContent = "FREE";

        const rewardLabel = document.getElementById("completion-reward-label");
        const reward = document.getElementById("completion-reward");
        const rewardNote = document.getElementById("completion-reward-note");
        rewardLabel.textContent = "CREDIT EFFECT";
        reward.textContent = "0 credits";
        rewardNote.textContent = "Testing mode · no credits changed";
        completionSummary.hidden = false;
        gameHud.dataset.completed = "true";
    }

    function placeOrRotateMirror(row, col) {
        if (tracing || corePowered) return;
        if ((row === GRID.start.row && col === GRID.start.col) ||
            (row === GRID.target.row && col === GRID.target.col)) {
            setFeedback("The source and battery occupy those tiles.");
            return;
        }
        startSolveTimer();
        const cellKey = gridKey(row, col);
        const existing = placedMirrors.get(cellKey);
        if (existing) {
            existing.slash = !existing.slash;
            orientMirror(existing);
            setFeedback(`Mirror at row ${row + 1}, column ${col + 1} rotated to ${existing.slash ? "/" : "\\"}.`);
        } else {
            createPlayerMirror(row, col, true);
            setFeedback(`Mirror placed at row ${row + 1}, column ${col + 1}. Tap it again to rotate.`);
        }

        clearObjectGroup(activeBeamGroup);
        beamSegments.length = 0;
        previewRoute = traceLight();
        if (previewRoute.outcome === "powered") {
            setFeedback("Route ready. Press POWER SOURCE to launch the beam.", "ready");
        } else if (previewRoute.outcome === "underpowered") {
            const needed = activeLevel.par - previewRoute.reflections;
            setFeedback(
                `Battery reached, but this sector requires ${activeLevel.par} mirrors on the beam path. Add ${needed} more.`,
                "miss"
            );
        } else if (previewRoute.outcome === "loop") {
            setFeedback("This route loops. Rotate or move a mirror before launching.", "miss");
        } else {
            setFeedback(
                `The route exits after row ${previewRoute.finalCell.row + 1}, column ${previewRoute.finalCell.col + 1}. Adjust a mirror before launching.`,
                "miss"
            );
        }
    }

    function toggleLaunchDirection() {
        if (tracing || corePowered) return;
        startSolveTimer();
        launchDirection = launchDirection === 1 ? 3 : 1;
        updateSourceMarker();
        clearObjectGroup(activeBeamGroup);
        beamSegments.length = 0;
        previewRoute = placedMirrors.size ? traceLight() : null;
        setFeedback(
            `Source points ${launchDirection === 1 ? "right" : "left"}. Place mirrors, then press POWER SOURCE to launch.`
        );
    }

    function animateTrace() {
        if (tracing || corePowered) return;
        startSolveTimer();
        previewRoute = traceLight();
        environmentNetwork.visible = false;
        drawActiveRoute(previewRoute, 0);
        if (sourcePylon?.userData.beaconLight) sourcePylon.userData.beaconLight.intensity = 12;
        tracing = true;
        traceStartedAt = performance.now();
        traceResult = previewRoute;
        traceButton.disabled = true;
        traceButton.innerHTML = "<span>…</span> TRACING";
        setStatus("Power source activated", "Tracing the live light path through your reflectors…");
    }

    function resetGame() {
        tracing = false;
        traceResult = null;
        previewRoute = null;
        levelStartedAt = null;
        completionSummary.hidden = true;
        delete gameHud.dataset.completed;
        launchDirection = activeLevel.start.direction;
        updateSourceMarker();
        placedMirrors.clear();
        clearObjectGroup(mirrorGroup);
        clearObjectGroup(activeBeamGroup);
        beamSegments.length = 0;
        environmentNetwork.visible = true;
        setCorePowered(false);
        coreLight.intensity = 14;
        if (sourcePylon?.userData.beaconLight) sourcePylon.userData.beaconLight.intensity = 7;
        traceButton.disabled = false;
        traceButton.innerHTML = "<span>▶</span> POWER SOURCE";
        setStatus(
            `Level ${String(activeLevel.number).padStart(2, "0")} — ${activeLevel.title}`,
            `Requires ${activeLevel.par} mirror${activeLevel.par === 1 ? "" : "s"} on the beam path. Tap the source to switch side, place mirrors, then launch.`
        );
    }

    function pickTile(event) {
        const bounds = canvas.getBoundingClientRect();
        pointerNdc.set(
            ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
            -((event.clientY - bounds.top) / bounds.height) * 2 + 1
        );
        raycaster.setFromCamera(pointerNdc, camera);
        const hits = raycaster.intersectObjects(tileTargets, false);
        return hits.length ? hits[0].object.userData : null;
    }

    function bindGameplay(hoverRing) {
        canvas.addEventListener("pointermove", (event) => {
            if (cameraState.pointers.size !== 0 || cameraState.dragging || cameraState.moved) return;
            const cell = pickTile(event);
            if (!cell ||
                (cell.row === GRID.start.row && cell.col === GRID.start.col) ||
                (cell.row === GRID.target.row && cell.col === GRID.target.col)) {
                hoverRing.visible = false;
                return;
            }
            const obstacleIndex = activeLevel.obstacles.findIndex(
                (obstacle) => obstacle.row === cell.row && obstacle.col === cell.col
            );
            const hoverHeight = obstacleIndex < 0
                ? 0.27
                : 0.19 + 0.52 + (obstacleIndex % 2) * 0.16 + 0.08;
            hoverRing.position.set(gridX(cell.col), hoverHeight, gridZ(cell.row));
            hoverRing.visible = !corePowered && !tracing;
        });

        canvas.addEventListener("pointerup", (event) => {
            if (cameraState.moved || cameraState.pointers.size !== 0) return;
            const bounds = canvas.getBoundingClientRect();
            pointerNdc.set(
                ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
                -((event.clientY - bounds.top) / bounds.height) * 2 + 1
            );
            raycaster.setFromCamera(pointerNdc, camera);
            if (raycaster.intersectObjects(sourceTargets, false).length) {
                toggleLaunchDirection();
                return;
            }
            const cell = pickTile(event);
            if (cell) placeOrRotateMirror(cell.row, cell.col);
        });

        canvas.addEventListener("pointercancel", () => {
            hoverRing.visible = false;
        });

        traceButton.addEventListener("click", animateTrace);
        resetButton.addEventListener("click", resetGame);
    }

    function createLooseSlabs() {
        const shards = [
            [[-6.4, -3.8], [-5.8, -4.12], [-5.45, -3.75], [-5.86, -3.32]],
            [[-6.44, 2.98], [-5.92, 2.77], [-5.5, 3.12], [-5.85, 3.56]],
            [[-3.1, -4.8], [-2.6, -4.5], [-2.4, -4.02], [-2.93, -4.17]],
            [[4.72, -3.78], [5.24, -3.53], [5.4, -3.05], [4.91, -3.12]],
            [[5.55, 0.9], [6.08, 0.7], [6.19, 1.2], [5.74, 1.47]],
            [[3.34, 3.56], [4.01, 3.41], [4.22, 3.85], [3.71, 4.13]],
            [[-4.88, 3.75], [-4.35, 3.58], [-4.08, 4.02], [-4.57, 4.2]]
        ];
        shards.forEach((points, i) => {
            const mesh = extrudedPolygon(platform, points, 0.18, -0.005, materials.floor[(i + 2) % materials.floor.length], 0.015);
            mesh.rotation.y = (i % 2 ? -1 : 1) * 0.055;
        });
    }

    function createColumnsAndRuins() {
        const columns = [
            [-7.3, -4.1, 10.8, 0.72],
            [-5.8, -5.25, 9.4, 0.54],
            [-3.0, -5.55, 11.5, 0.6],
            [-0.15, -5.45, 10.7, 0.74],
            [2.68, -5.1, 12.3, 0.63],
            [-7.55, -0.75, 10.1, 0.78],
            [-7.45, 2.1, 8.8, 0.65],
            [6.55, -3.7, 11.8, 0.74]
        ];

        columns.forEach(([x, z, height, radius], i) => {
            const baseY = -0.12;
            const columnGroup = new THREE.Group();
            columnGroup.position.set(x, baseY, z);
            world.add(columnGroup);

            addBox(columnGroup, [radius * 2.8, 0.34, radius * 2.8], [0, 0, 0], materials.metal);
            addBox(columnGroup, [radius * 2.35, 0.17, radius * 2.35], [0, 0.24, 0], materials.columnLight);

            const shaft = new THREE.Mesh(
                new THREE.CylinderGeometry(radius * 0.82, radius, height, 10, 1, false),
                materials.column
            );
            shaft.position.y = height / 2 + 0.3;
            shaft.castShadow = true;
            shaft.receiveShadow = true;
            columnGroup.add(shaft);

            for (let band = 0; band < 4; band++) {
                const y = 0.48 + height * (band + 1) / 5;
                const collar = new THREE.Mesh(
                    new THREE.CylinderGeometry(radius * 0.9, radius * 0.94, 0.14, 10),
                    band === 1 && i % 3 === 0 ? materials.columnLight : materials.metal
                );
                collar.position.y = y;
                collar.castShadow = true;
                columnGroup.add(collar);
            }

            addBox(
                columnGroup,
                [radius * 2.3, 0.38, radius * 2.3],
                [0, height + 0.39, 0],
                materials.metal
            );
            addBox(
                columnGroup,
                [radius * 1.65, 0.18, radius * 1.65],
                [0, height + 0.67, 0],
                materials.columnLight
            );

            if (i === 0 || i === 5) {
                addBox(
                    world,
                    [0.9, height * 0.76, 0.2],
                    [x + 0.58, height * 0.53, z + 0.22],
                    materials.underside,
                    { rotation: [0, -0.08, -0.035] }
                );
            }
        });

        const buttresses = [
            [-6.4, -2.6, 3.8, 3.1, 0.72, -0.14],
            [-5.7, -4.4, 2.7, 2.6, 0.68, 0.12],
            [-3.9, -5.35, 2.3, 2.2, 0.65, -0.08],
            [-7.0, 0.9, 2.4, 2.2, 0.7, -0.12]
        ];
        buttresses.forEach(([x, z, h, w, d, rot], i) => {
            addBox(world, [w, h, d], [x, h / 2 - 0.06, z], i % 2 ? materials.columnLight : materials.column, {
                rotation: [0, 0, rot]
            });
            addBox(world, [w * 1.28, 0.34, d * 1.5], [x, 0.12, z], materials.metal);
        });

        createTruss(-1);
    }

    function addBar(parent, a, b, thickness, material) {
        const start = new THREE.Vector3(...a);
        const end = new THREE.Vector3(...b);
        const direction = new THREE.Vector3().subVectors(end, start);
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(thickness, thickness, direction.length()),
            material
        );
        mesh.position.copy(start).add(end).multiplyScalar(0.5);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        world.add(mesh);
        return mesh;
    }

    function createTruss() {
        const beamMaterial = makeMaterial(0x202a36, 0.43, 0.84);
        const supportMaterial = makeMaterial(0x303944, 0.42, 0.82);
        const topY = 5.7;
        const lowY = 4.9;
        const backZ = -7.1;

        addBar(world, [-6.9, lowY, backZ], [8.2, lowY, backZ], 0.16, beamMaterial);
        addBar(world, [-6.9, topY, backZ], [8.2, topY, backZ], 0.16, beamMaterial);
        for (let i = 0; i <= 14; i++) {
            const x = -6.9 + i * 1.08;
            addBar(world, [x, lowY, backZ], [x, topY, backZ], 0.085, supportMaterial);
            if (i < 14) {
                const nextX = x + 1.08;
                const low = i % 2 === 0;
                addBar(
                    world,
                    [x, low ? lowY : topY, backZ],
                    [nextX, low ? topY : lowY, backZ],
                    0.075,
                    beamMaterial
                );
            }
        }

        const sideX = 7.25;
        addBar(world, [sideX, 4.85, -5.6], [sideX, 4.85, 4.7], 0.15, beamMaterial);
        addBar(world, [sideX, 5.65, -5.6], [sideX, 5.65, 4.7], 0.15, beamMaterial);
        for (let i = 0; i <= 9; i++) {
            const z = -5.6 + i * 1.14;
            addBar(world, [sideX, 4.85, z], [sideX, 5.65, z], 0.078, supportMaterial);
            if (i < 9) {
                const nextZ = z + 1.14;
                const low = i % 2 === 0;
                addBar(
                    world,
                    [sideX, low ? 4.85 : 5.65, z],
                    [sideX, low ? 5.65 : 4.85, nextZ],
                    0.066,
                    beamMaterial
                );
            }
        }

        // A broken service gantry sits at the near-left edge, as in the reference.
        addBar(world, [-8.1, 0.7, 0.8], [-8.1, 0.7, 6.1], 0.26, beamMaterial);
        addBar(world, [-8.1, 1.7, 0.8], [-8.1, 1.7, 6.1], 0.2, beamMaterial);
        for (let i = 0; i < 5; i++) {
            const z = 1 + i * 1.05;
            addBar(world, [-8.1, 0.7, z], [-8.1, 1.7, z], 0.11, supportMaterial);
            if (i < 4) addBar(world, [-8.1, i % 2 ? 0.7 : 1.7, z], [-8.1, i % 2 ? 1.7 : 0.7, z + 1.05], 0.09, beamMaterial);
        }
    }

    function createPylon(x, z, color, scale = 1, type = "relay") {
        const group = new THREE.Group();
        group.position.set(x, 0.05, z);
        platform.add(group);
        const colorMaterial = new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 0.72,
            metalness: 0.18,
            roughness: 0.22
        });
        const whiteMaterial = makeMaterial(0xa8b3bb, 0.31, 0.76);
        const foot = addBox(group, [0.8 * scale, 0.14, 0.67 * scale], [0, 0.12, 0], materials.metal);
        foot.rotation.y = Math.PI / 8;
        addBox(group, [0.62 * scale, 0.09, 0.48 * scale], [0, 0.23, 0], materials.metalEdge);
        addBox(group, [0.43 * scale, 0.045, 0.34 * scale], [0, 0.3, 0], colorMaterial);

        const shaftHeight = (type === "beacon" ? 1.14 : 0.72) * scale;
        const crystal = new THREE.Mesh(
            new THREE.BoxGeometry(0.25 * scale, shaftHeight, 0.25 * scale),
            colorMaterial
        );
        crystal.position.set(0, 0.34 + shaftHeight / 2, 0);
        crystal.rotation.y = Math.PI / 4;
        crystal.castShadow = true;
        group.add(crystal);
        addBox(group, [0.36 * scale, 0.08, 0.36 * scale], [0, 0.35 + shaftHeight, 0], whiteMaterial);

        const pointLight = new THREE.PointLight(color, type === "beacon" ? 7 : 3, type === "beacon" ? 3.8 : 2.4, 2);
        pointLight.position.set(0, 0.85 + shaftHeight, 0);
        group.add(pointLight);
        if (type === "beacon") group.userData.beaconLight = pointLight;
        return group;
    }

    function createTerminals() {
        sourcePylon = createPylon(-2.55, -3.55, colors.pink, 0.8, "beacon");
        createPylon(-5.1, -1.15, colors.pink, 0.76, "beacon");
        createPylon(-1.15, -1.78, colors.pink, 0.68, "relay");
        createPylon(0.02, -0.82, colors.pink, 0.84, "beacon");
        createPylon(-0.82, 1.16, colors.pink, 0.84, "beacon");

        createPylon(-3.62, 2.95, colors.amber, 0.8, "relay");
        createPylon(-2.2, 1.48, colors.amber, 0.84, "relay");
        createPylon(5.0, 0.58, colors.amber, 0.86, "beacon");

        createPylon(2.82, -3.75, colors.blue, 0.88, "beacon");
        createPylon(3.88, 3.0, colors.blue, 0.86, "beacon");
        createPylon(2.7, -2.95, colors.blue, 0.74, "relay");

    }

    function addLightPath(points, color, radius = 0.018) {
        const material = new THREE.MeshBasicMaterial({
            color,
            toneMapped: false,
            blending: THREE.AdditiveBlending
        });
        const glowMaterial = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.075,
            depthWrite: false,
            toneMapped: false,
            blending: THREE.AdditiveBlending
        });
        for (let i = 0; i < points.length - 1; i++) {
            const [x1, z1, h1 = 0.38] = points[i];
            const [x2, z2, h2 = 0.38] = points[i + 1];
            const start = new THREE.Vector3(x1, h1, z1);
            const end = new THREE.Vector3(x2, h2, z2);
            const path = new THREE.LineCurve3(start, end);
            environmentNetwork.add(
                new THREE.Mesh(new THREE.TubeGeometry(path, 1, radius * 3.4, 7, false), glowMaterial),
                new THREE.Mesh(new THREE.TubeGeometry(path, 1, radius, 6, false), material)
            );
        }
        points.slice(1, -1).forEach(([x, z, height = 0.38]) => {
            const junction = new THREE.Mesh(
                new THREE.SphereGeometry(radius * 2.2, 8, 6),
                new THREE.MeshBasicMaterial({ color, toneMapped: false })
            );
            junction.position.set(x, height, z);
            environmentNetwork.add(junction);
        });
    }

    function createLightNetwork() {
        addLightPath([
            [-2.55, -3.55, 0.48], [-2.55, -2.87, 0.38], [-3.08, -2.42, 0.38],
            [-3.08, -1.76, 0.38], [-4.35, -1.76, 0.38], [-4.35, -0.92, 0.38],
            [-5.1, -1.15, 0.47]
        ], colors.pink, 0.022);
        addLightPath([
            [-5.1, -1.15, 0.44], [-4.43, -0.62, 0.38], [-3.53, -0.62, 0.38],
            [-2.82, -1.42, 0.38], [-1.15, -1.78, 0.48]
        ], colors.pink, 0.021);

        addLightPath([
            [-3.62, 2.95, 0.42], [-2.72, 2.05, 0.38], [-2.2, 1.48, 0.46],
            [-2.2, -0.92, 0.38], [-0.82, -0.92, 0.38], [-0.82, 1.16, 0.46]
        ], colors.amber, 0.024);
        addLightPath([
            [-2.2, 1.48, 0.43], [-1.2, 1.48, 0.38], [-1.2, -0.08, 0.43],
            [0.02, -0.82, 0.48], [1.35, 0.1, 0.62], [3.08, -1.55, 0.4],
            [5.0, 0.58, 0.54]
        ], colors.amber, 0.024);

        addLightPath([
            [2.82, -3.75, 0.52], [2.38, -2.72, 0.38], [1.42, -1.95, 0.38],
            [0.38, -0.95, 0.38], [-0.82, -0.92, 0.43], [-0.82, 1.16, 0.55]
        ], colors.blue, 0.023);
        addLightPath([
            [-0.82, 1.16, 0.46], [0.55, 0.62, 0.39], [1.35, 0.1, 0.68],
            [2.23, 1.13, 0.4], [2.96, 2.05, 0.4], [3.88, 3.0, 0.53]
        ], colors.blue, 0.026);

        [
            { x: -3.62, z: 2.95, color: colors.amber },
            { x: 0.02, z: -0.82, color: colors.pink },
            { x: 2.82, z: -3.75, color: colors.blue }
        ].forEach(({ x, z, color }) => {
            const lamp = new THREE.PointLight(color, 3.5, 4.5, 2);
            lamp.position.set(x, 0.48, z);
            platform.add(lamp);
        });
    }

    function createCore() {
        const firstCoreChild = platform.children.length;
        const x = 1.35;
        const z = 0.1;
        const baseMaterials = [
            makeMaterial(0x343b43, 0.5, 0.78),
            makeMaterial(0x252d36, 0.46, 0.82),
            makeMaterial(0x434951, 0.47, 0.76)
        ];

        addCylinder(platform, 1.62, 1.82, 0.42, [x, 0.12, z], baseMaterials[1], 16);
        addCylinder(platform, 1.42, 1.64, 0.21, [x, 0.41, z], baseMaterials[0], 48);
        addCylinder(platform, 1.25, 1.42, 0.15, [x, 0.57, z], baseMaterials[2], 48);
        addCylinder(platform, 1.07, 1.2, 0.11, [x, 0.69, z], baseMaterials[1], 48);
        addCylinder(platform, 0.89, 1.03, 0.09, [x, 0.79, z], baseMaterials[0], 48);

        const blueMetal = new THREE.MeshStandardMaterial({
            color: 0x4fbfe2,
            emissive: 0x087ab1,
            emissiveIntensity: 0.42,
            metalness: 0.72,
            roughness: 0.3
        });
        const ring = (radius, tube, y, material, segments = 64) => {
            const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, segments), material);
            mesh.rotation.x = Math.PI / 2;
            mesh.position.set(x, y, z);
            mesh.castShadow = true;
            platform.add(mesh);
            return mesh;
        };
        ring(1.48, 0.045, 0.58, blueMetal);
        ring(1.14, 0.032, 0.84, blueMetal);
        ring(0.93, 0.026, 0.91, blueMetal);

        for (let i = 0; i < 16; i++) {
            const angle = (i / 16) * Math.PI * 2;
            const radial = i % 2 === 0 ? 1.46 : 1.3;
            const tooth = addBox(
                platform,
                [0.58, 0.16, i % 2 === 0 ? 0.46 : 0.35],
                [x + Math.cos(angle) * radial, 0.39, z + Math.sin(angle) * radial],
                baseMaterials[i % baseMaterials.length]
            );
            tooth.rotation.y = -angle;
        }

        for (let i = 0; i < 12; i++) {
            const angle = (i / 12) * Math.PI * 2;
            const r = 1.26;
            const inset = addBox(
                platform,
                [0.24, 0.07, 0.37],
                [x + Math.cos(angle) * r, 0.73, z + Math.sin(angle) * r],
                i % 3 === 0 ? blueMetal : baseMaterials[1]
            );
            inset.rotation.y = -angle;
            if (i % 3 === 0) {
                const light = new THREE.PointLight(colors.blue, 1.1, 1.8, 2);
                light.position.set(x + Math.cos(angle) * r, 0.85, z + Math.sin(angle) * r);
                platform.add(light);
            }
        }

        const hologram = new THREE.Group();
        hologram.position.set(x, 1.42, z);
        platform.add(hologram);
        const hologramMaterial = (color, opacity) => new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            side: THREE.DoubleSide,
            depthWrite: false,
            toneMapped: false,
            blending: THREE.AdditiveBlending
        });

        const shaft = new THREE.Mesh(
            new THREE.CylinderGeometry(0.025, 0.045, 4.2, 10),
            new THREE.MeshBasicMaterial({
                color: 0x65ebf4,
                transparent: true,
                opacity: 0.1,
                depthWrite: false,
                toneMapped: true
            })
        );
        shaft.position.y = 2.25;
        hologram.add(shaft);

        const shaftGlow = new THREE.Mesh(
            new THREE.CylinderGeometry(0.085, 0.12, 4.2, 10),
            new THREE.MeshBasicMaterial({
                color: 0x43dce9,
                transparent: true,
                opacity: 0.035,
                depthWrite: false,
                toneMapped: true
            })
        );
        shaftGlow.position.y = 2.25;
        hologram.add(shaftGlow);

        const disc = new THREE.Mesh(
            new THREE.CircleGeometry(0.89, 64),
            hologramMaterial(0x2acfff, 0.12)
        );
        disc.rotation.x = -Math.PI / 2;
        hologram.add(disc);

        [0.25, 0.42, 0.61, 0.78].forEach((radius, i) => {
            const orbitRing = new THREE.Mesh(
                new THREE.TorusGeometry(radius, i % 2 ? 0.009 : 0.014, 5, 64),
                hologramMaterial(i === 2 ? 0xa7ffff : colors.cold, i === 2 ? 0.44 : 0.3)
            );
            orbitRing.rotation.x = Math.PI / 2;
            orbitRing.position.y = i % 2 ? 0.018 : -0.012;
            hologram.add(orbitRing);
        });

        for (let i = 0; i < 48; i++) {
            const angle = i / 48 * Math.PI * 2;
            const inner = i % 4 === 0 ? 0.62 : 0.7;
            const outer = i % 4 === 0 ? 0.84 : 0.77;
            const line = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(Math.cos(angle) * inner, 0.012, Math.sin(angle) * inner),
                    new THREE.Vector3(Math.cos(angle) * outer, 0.012, Math.sin(angle) * outer)
                ]),
                new THREE.LineBasicMaterial({
                    color: i % 4 === 0 ? 0xd5ffff : 0x68ddff,
                    transparent: true,
                    opacity: i % 4 === 0 ? 0.9 : 0.56,
                    toneMapped: false,
                    blending: THREE.AdditiveBlending
                })
            );
            hologram.add(line);
        }

        const centralGlyph = new THREE.Mesh(
            new THREE.CircleGeometry(0.28, 6),
            hologramMaterial(0x9bffff, 0.42)
        );
        centralGlyph.rotation.x = -Math.PI / 2;
        centralGlyph.position.y = 0.024;
        hologram.add(centralGlyph);

        corePulse = new THREE.Mesh(
            new THREE.SphereGeometry(0.23, 20, 16),
            new THREE.MeshStandardMaterial({
                color: 0x317b94,
                emissive: 0x1287aa,
                emissiveIntensity: 0.32,
                metalness: 0.38,
                roughness: 0.2
            })
        );
        corePulse.position.y = 0.09;
        hologram.add(corePulse);
        hologram.userData.animate = true;
        animatedObjects.push(hologram);

        coreSystem = new THREE.Group();
        platform.children.slice(firstCoreChild).forEach((child) => {
            platform.remove(child);
            coreSystem.add(child);
        });
        platform.add(coreSystem);
    }

    function addBackdropArchitecture() {
        const wallFragments = [
            [-9.2, -3.4, 8.8, 6.5, 0.6, -0.04],
            [-8.5, -0.7, 6.6, 7.4, 0.64, 0.06],
            [-7.0, -6.45, 4.2, 6.0, 0.55, 0.02],
            [5.25, -7.5, 3.0, 6.7, 0.56, -0.06]
        ];
        wallFragments.forEach(([x, z, height, width, depth, lean], i) => {
            addBox(
                world,
                [width, height, depth],
                [x, height / 2 - 0.25, z],
                i % 2 ? materials.underside : materials.column,
                { rotation: [0, 0, lean] }
            );
            for (let j = 0; j < 2; j++) {
                addBox(
                    world,
                    [0.15, height * 0.78, depth + 0.12],
                    [x - width * 0.3 + j * width * 0.6, height * 0.48, z + 0.02],
                    materials.metal
                );
            }
        });

        // Recessed vertical wall bays add the industrial rhythm visible behind the pylons.
        for (let i = 0; i < 5; i++) {
            const x = -7.5 + i * 2.25;
            addBox(world, [0.08, 5.6, 0.08], [x, 2.6, -6.25], materials.metalEdge);
            addBox(world, [0.68, 0.08, 0.16], [x, 5.18, -6.18], materials.metal);
            if (i % 2 === 0) {
                addBox(world, [0.58, 3.1, 0.1], [x + 0.55, 3.5, -6.12], materials.underside);
            }
        }
    }

    function setupCamera() {
        const target = new THREE.Vector3(-0.65, 0.2, -0.1);
        const horizontal = Math.cos(cameraState.elevation) * cameraState.distance;
        camera.position.set(
            target.x + Math.sin(cameraState.azimuth) * horizontal,
            target.y + Math.sin(cameraState.elevation) * cameraState.distance,
            target.z + Math.cos(cameraState.azimuth) * horizontal
        );
        camera.lookAt(target);
    }

    function resetCamera() {
        cameraState.azimuth = cameraState.defaultAzimuth;
        cameraState.elevation = cameraState.defaultElevation;
        cameraState.distance = window.innerWidth < 620 ? 17.5 : 12.5;
        setupCamera();
    }

    function resize() {
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        const mobileQuality = width < 620;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobileQuality ? 1 : 1.35));
        renderer.shadowMap.enabled = !mobileQuality;
        moonLight.castShadow = !mobileQuality;
        renderer.setSize(width, height, false);
        composer.setSize(width, height);
        camera.aspect = width / height;
        camera.fov = width < 620 ? 60 : 37;
        camera.updateProjectionMatrix();
        bloom.setSize(width, height);
        resetCamera();
    }
    window.fluxGridSceneResize = resize;

    function orbitBy(horizontal, vertical) {
        cameraState.azimuth += horizontal;
        cameraState.elevation = THREE.MathUtils.clamp(cameraState.elevation + vertical, 0.12, 1.42);
        setupCamera();
    }

    function pointerDistance() {
        const points = [...cameraState.pointers.values()];
        if (points.length < 2) return 0;
        return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    }

    function bindCameraControls() {
        document.getElementById("camera-left").addEventListener("click", () => orbitBy(-Math.PI / 10, 0));
        document.getElementById("camera-right").addEventListener("click", () => orbitBy(Math.PI / 10, 0));
        document.getElementById("camera-up").addEventListener("click", () => orbitBy(0, -0.1));
        document.getElementById("camera-down").addEventListener("click", () => orbitBy(0, 0.1));
        document.getElementById("camera-reset").addEventListener("click", resetCamera);

        canvas.addEventListener("pointerdown", (event) => {
            cameraState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            canvas.setPointerCapture(event.pointerId);
            if (cameraState.pointers.size === 1) {
                cameraState.dragging = true;
                cameraState.moved = false;
                cameraState.lastX = event.clientX;
                cameraState.lastY = event.clientY;
            } else if (cameraState.pointers.size === 2) {
                cameraState.dragging = false;
                cameraState.moved = true;
                cameraState.pinchDistance = pointerDistance();
            }
        });

        canvas.addEventListener("pointermove", (event) => {
            if (!cameraState.pointers.has(event.pointerId)) return;
            const previous = cameraState.pointers.get(event.pointerId);
            cameraState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (cameraState.pointers.size > 1) {
                const distance = pointerDistance();
                if (cameraState.pinchDistance && distance) {
                    cameraState.distance = THREE.MathUtils.clamp(
                        cameraState.distance - (distance - cameraState.pinchDistance) * 0.035,
                        12,
                        36
                    );
                    setupCamera();
                }
                cameraState.pinchDistance = distance;
                return;
            }
            if (!cameraState.dragging) return;
            const dx = event.clientX - cameraState.lastX;
            const dy = event.clientY - cameraState.lastY;
            cameraState.lastX = event.clientX;
            cameraState.lastY = event.clientY;
            if (Math.abs(event.clientX - previous.x) + Math.abs(event.clientY - previous.y) > 2) {
                cameraState.moved = true;
            }
            if (cameraState.moved) {
                cameraState.azimuth -= dx * 0.006;
                cameraState.elevation = THREE.MathUtils.clamp(cameraState.elevation + dy * 0.004, 0.12, 1.42);
                setupCamera();
            }
        });

        const releasePointer = (event) => {
            cameraState.pointers.delete(event.pointerId);
            cameraState.dragging = false;
            cameraState.pinchDistance = cameraState.pointers.size > 1 ? pointerDistance() : 0;
        };
        canvas.addEventListener("pointerup", releasePointer);
        canvas.addEventListener("pointercancel", releasePointer);
        canvas.addEventListener("wheel", (event) => {
            event.preventDefault();
            cameraState.distance = THREE.MathUtils.clamp(cameraState.distance + event.deltaY * 0.012, 12, 36);
            setupCamera();
        }, { passive: false });
    }

    createVoid();
    createFloatingPlatform();
    addBackdropArchitecture();
    createColumnsAndRuins();
    createCore();
    createTerminals();
    createLightNetwork();
    createSquarePlacementGrid();
    const hoverRing = createGameplaySurface();
    bindCameraControls();
    bindGameplay(hoverRing);
    resize();
    window.addEventListener("fluxgrid:load-level", (event) => loadLevel(event.detail));

    const clock = new THREE.Clock();
    function render() {
        requestAnimationFrame(render);
        if (document.hidden || canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
        const time = clock.getElapsedTime();
        if (tracing && traceResult) {
            const duration = Math.max(650, traceResult.segments.length * 175);
            const progress = Math.min(1, (performance.now() - traceStartedAt) / duration);
            const visibleCount = progress >= 1
                ? traceResult.segments.length
                : Math.min(traceResult.segments.length, Math.floor(progress * traceResult.segments.length) + 1);
            beamSegments.forEach(({ glow, core }, index) => {
                const visible = index < visibleCount;
                glow.visible = visible;
                core.visible = visible;
            });

            if (progress >= 1) {
                tracing = false;
                traceButton.disabled = false;
                traceButton.innerHTML = "<span>▶</span> TRACE AGAIN";
                if (traceResult.outcome === "powered") {
                    setCorePowered(true);
                    traceButton.disabled = true;
                    traceButton.innerHTML = "<span>✓</span> CORE ONLINE";
                    coreLight.intensity = 28;
                    const elapsedMilliseconds = calculateSolveTimeMilliseconds(
                        levelStartedAt,
                        performance.now(),
                        traceResult.outcome === "powered"
                    );
                    if (elapsedMilliseconds === null) {
                        console.error("Solved level did not have a valid running solve timer.", {
                            level: activeLevel.number,
                            startedAt: levelStartedAt
                        });
                        return;
                    }
                    const starResult = evaluateLevelStars(activeLevel, elapsedMilliseconds, true);
                    const starLabel = starResult.stars === 3
                        ? "3 stars"
                        : starResult.stars === 2
                            ? "2 stars"
                            : "1 star";
                    showCompletionSummary(activeLevel, elapsedMilliseconds, starResult);
                    setStatus("Battery connected", `Level ${String(activeLevel.number).padStart(2, "0")} complete. Rating: ${starLabel}. Credit preview only; no balance changed.`, "success");
                    window.dispatchEvent(new CustomEvent("fluxgrid:level-complete", {
                        detail: {
                            number: activeLevel.number,
                            stars: starResult.stars,
                            elapsedMilliseconds,
                            walletSessionId: walletLevelSessionId,
                            launchDirection,
                            mirrors: [...placedMirrors.values()].map(({ row, col, slash }) => ({ row, col, slash }))
                        }
                    }));
                } else {
                    coreLight.intensity = 14;
                    if (sourcePylon?.userData.beaconLight) sourcePylon.userData.beaconLight.intensity = 7;
                    const ending = traceResult.outcome === "loop"
                        ? "The beam loops back on itself."
                        : traceResult.outcome === "blocked"
                            ? "The beam hits an obstacle."
                            : traceResult.outcome === "underpowered"
                                ? `The battery received the beam, but this sector requires ${activeLevel.par} mirrors on its path; only ${traceResult.reflections} reflected the beam.`
                            : "The beam misses the battery and exits the platform.";
                    setStatus("Route interrupted", `${ending} Adjust the mirrors or choose the other launch side.`, "miss");
                }
            }
        }
        for (const object of animatedObjects) {
            object.rotation.y = Math.sin(time * 0.12) * 0.025;
            object.position.y = 1.42 + Math.sin(time * 0.8) * 0.025;
        }
        if (corePowered) {
            coreLight.intensity = 16 + Math.sin(time * 4) * 2;
            corePulse.scale.setScalar(1 + Math.sin(time * 3.2) * 0.08);
        } else {
            coreLight.intensity = 14;
            if (corePulse) corePulse.scale.setScalar(1 + Math.sin(time * 1.8) * 0.025);
        }
        if (renderer.shadowMap.enabled) composer.render();
        else renderer.render(scene, camera);
    }
    render();
    window.addEventListener("resize", resize);
}
