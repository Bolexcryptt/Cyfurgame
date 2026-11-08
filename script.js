import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import {
    levels,
    calculateSolveTimeMilliseconds,
    evaluateLevelStars,
    traceLaserRoute
} from "./levels.js";

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
    scene.background = null;
    scene.fog = new THREE.FogExp2(0x10151c, 0.0075);

    const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 160);
    const mobileQuality = window.innerWidth < 620;
    const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: !mobileQuality,
        powerPreference: "high-performance"
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobileQuality ? 1.5 : 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.78;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const configureQualityLight = (light) => {
        light.visible = !mobileQuality;
        return light;
    };

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.2, 0.36, 1);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    scene.add(new THREE.HemisphereLight(0xa6b6c8, 0x302a25, mobileQuality ? 1.15 : 0.95));

    const moonLight = new THREE.DirectionalLight(0xffdfbd, 2.25);
    moonLight.position.set(-7, 15, -4);
    moonLight.castShadow = true;
    moonLight.shadow.mapSize.set(mobileQuality ? 1024 : 2048, mobileQuality ? 1024 : 2048);
    moonLight.shadow.camera.left = -14;
    moonLight.shadow.camera.right = 14;
    moonLight.shadow.camera.top = 14;
    moonLight.shadow.camera.bottom = -14;
    moonLight.shadow.bias = -0.00035;
    scene.add(moonLight);
    const boardFillLight = new THREE.DirectionalLight(0x8eabc5, mobileQuality ? 0.62 : 0.48);
    boardFillLight.position.set(5, 9, 4);
    scene.add(boardFillLight);
    const islandRimLight = new THREE.DirectionalLight(0xb7c1c6, mobileQuality ? 0.72 : 0.58);
    islandRimLight.position.set(8, -5, 12);
    scene.add(islandRimLight);

    const warmLight = configureQualityLight(new THREE.PointLight(0xff7134, 17, 12, 2));
    warmLight.position.set(-3.8, 2.7, 1.7);
    scene.add(warmLight);
    const magentaLight = configureQualityLight(new THREE.PointLight(colors.pink, 10, 9, 2));
    magentaLight.position.set(-4.7, 1.5, -1.5);
    scene.add(magentaLight);
    const blueLight = configureQualityLight(new THREE.PointLight(colors.blue, 15, 12, 2));
    blueLight.position.set(3.4, 2.2, 2.7);
    scene.add(blueLight);
    const coreLight = new THREE.PointLight(colors.cold, 8, 8, 2);
    coreLight.position.set(1.35, 1.5, 0.1);
    scene.add(coreLight);

    const world = new THREE.Group();
    scene.add(world);
    const platform = new THREE.Group();
    world.add(platform);
    const coreActivationGroup = new THREE.Group();
    coreActivationGroup.visible = false;
    platform.add(coreActivationGroup);
    const activationRingMaterials = [];
    [0.5, 0.68, 0.84].forEach((radius, index) => {
        const material = new THREE.MeshBasicMaterial({
            color: index === 1 ? 0xb6fbff : colors.cold,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
            blending: THREE.AdditiveBlending
        });
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(radius, index === 1 ? 0.026 : 0.018, 6, 36),
            material
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.25 + index * 0.045;
        coreActivationGroup.add(ring);
        activationRingMaterials.push(material);
    });
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
    const tutorialTargetMarker = new THREE.Mesh(
        new THREE.TorusGeometry(0.48, 0.035, 6, 28),
        new THREE.MeshBasicMaterial({
            color: 0x8cffff,
            transparent: true,
            opacity: 0.78,
            toneMapped: false
        })
    );
    tutorialTargetMarker.rotation.x = Math.PI / 2;
    tutorialTargetMarker.position.y = 0.24;
    tutorialTargetMarker.visible = false;
    platform.add(tutorialTargetMarker);

    const GRID = {
        rows: 6,
        cols: 8,
        step: 1.4,
        x0: -5.6,
        z0: -3.8,
        start: { row: 0, col: 2 },
        target: { row: 3, col: 5 }
    };
    const CORE_SCALE = 0.36;
    const CORE_HOLOGRAM_Y = 1.42;
    const CORE_PULSE_Y = 0.09;
    const CORE_CONTACT_HEIGHT = CORE_SCALE * (CORE_HOLOGRAM_Y + CORE_PULSE_Y);
    const gridKey = (row, col) => `${row},${col}`;
    const gridX = (col) => GRID.x0 + col * GRID.step;
    const gridZ = (row) => GRID.z0 + row * GRID.step;
    const tileTargets = [];
    const sourceTargets = [];
    const placedMirrors = new Map();
    const levelCrystals = new Map();
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    const beamSegments = [];
    const animatedObjects = [];
    let activeLevel = levels[0];
    let previewRoute = null;
    let sourcePylon = null;
    let decorativeTerminalGroup = null;
    let sourceMarkerGroup = null;
    let sourceHitArea = null;
    let coreSystem = null;
    let corePulse = null;
    let corePowered = false;
    let coreActivatedAt = null;
    let pendingLevelCompletion = null;
    let tracing = false;
    let launchDirection = 1;
    let firstLevelTutorial = false;
    let firstLevelTutorialStage = "observe";
    let walletLevelSessionId = null;
    let walletLevelEntryCostCredits = null;
    let gameAccessPointsUsed = null;
    let gamePointsSession = false;
    let updateSourceMarker = () => {};
    let traceStartedAt = 0;
    let levelStartedAt = null;
    let traceResult = null;
    let renderRequest = 0;
    let audioContext = null;
    let audioQueueUntil = 0;
    let audioUnavailableReported = false;
    let powerSourceSoundPlayed = false;
    const fileSoundEffects = new Map([
        ["mirror", "mirror.mp3"],
        ["powerSource", "powersource.mp3"]
    ].map(([effect, file]) => {
        const audio = new Audio(new URL(file, document.baseURI));
        audio.preload = "auto";
        audio.load();
        return [effect, audio];
    }));
    const audioUnlockHandler = () => {
        document.removeEventListener("pointerdown", audioUnlockHandler, true);
        document.removeEventListener("keydown", audioUnlockHandler, true);
        const audio = fileSoundEffects.get("powerSource");
        audio.muted = true;
        try {
            const playback = audio.play();
            if (playback && typeof playback.then === "function") {
                void playback.then(() => {
                    audio.pause();
                    audio.currentTime = 0;
                    audio.muted = false;
                }).catch((error) => {
                    audio.muted = false;
                    console.warn("Power-source sound could not be unlocked.", error);
                });
            } else {
                audio.pause();
                audio.currentTime = 0;
                audio.muted = false;
            }
        } catch (error) {
            audio.muted = false;
            console.warn("Power-source sound could not be unlocked.", error);
        }
    };
    document.addEventListener("pointerdown", audioUnlockHandler, true);
    document.addEventListener("keydown", audioUnlockHandler, true);

    function playSoundEffect(effect) {
        const fileSound = fileSoundEffects.get(effect);
        if (fileSound) {
            try {
                fileSound.currentTime = 0;
                const playback = fileSound.play();
                if (playback && typeof playback.catch === "function") {
                    void playback.catch((error) => {
                        console.warn("Game sound effect could not be played.", error);
                    });
                }
            } catch (error) {
                console.warn("Game sound effect could not be played.", error);
            }
            return;
        }
        try {
            const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextConstructor) {
                if (!audioUnavailableReported) {
                    console.warn("Sound effects are unavailable in this browser.");
                    audioUnavailableReported = true;
                }
                return;
            }
            audioContext ??= new AudioContextConstructor();
            const sounds = {
                laser: { startFrequency: 180, endFrequency: 740, duration: 0.18, type: "sawtooth", volume: 0.055 },
                core: { startFrequency: 440, endFrequency: 1040, duration: 0.2, type: "sine", volume: 0.075 }
            };
            const sound = sounds[effect];
            if (!sound) return;
            const schedule = () => {
                if (audioContext.state !== "running") return;
                const startAt = Math.max(audioContext.currentTime, audioQueueUntil);
                const endAt = startAt + sound.duration;
                const oscillator = audioContext.createOscillator();
                const gain = audioContext.createGain();
                oscillator.type = sound.type;
                oscillator.frequency.setValueAtTime(sound.startFrequency, startAt);
                oscillator.frequency.exponentialRampToValueAtTime(sound.endFrequency, endAt);
                gain.gain.setValueAtTime(0.0001, startAt);
                gain.gain.exponentialRampToValueAtTime(sound.volume, startAt + 0.012);
                gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
                oscillator.connect(gain);
                gain.connect(audioContext.destination);
                oscillator.start(startAt);
                oscillator.stop(endAt);
                audioQueueUntil = endAt + 0.025;
            };
            if (audioContext.state !== "running") {
                void audioContext.resume().then(schedule).catch((error) => {
                    console.warn("Game sound effects could not be enabled.", error);
                });
                return;
            }
            schedule();
        } catch (error) {
            console.warn("Game sound effect could not be played.", error);
        }
    }

    const cameraState = {
        azimuth: 0.53,
        elevation: 0.63,
        distance: 16,
        defaultAzimuth: 0.53,
        defaultElevation: 0.63,
        dragging: false,
        moved: false,
        lastX: 0,
        lastY: 0,
        pointers: new Map(),
        pinchDistance: 0
    };

    const makeMaterial = (color, roughness = 0.8, metalness = 0.1, extra = {}) =>
        new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

    function createContactShadowMap() {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const context = canvas.getContext("2d");
        const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 62);
        gradient.addColorStop(0, "rgba(4, 5, 7, 0.82)");
        gradient.addColorStop(0.45, "rgba(4, 5, 7, 0.48)");
        gradient.addColorStop(1, "rgba(4, 6, 9, 0)");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 128, 128);
        return new THREE.CanvasTexture(canvas);
    }

    const contactShadowMap = createContactShadowMap();
    const contactShadowMaterial = new THREE.MeshBasicMaterial({
        map: contactShadowMap,
        color: 0xffffff,
        transparent: true,
        opacity: 0.64,
        depthWrite: false,
        toneMapped: false
    });

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
        const material = makeMaterial(color, 0.96, 0.015, {
            map,
            bumpMap,
            bumpScale: mobileQuality ? 0.06 : 0.15,
            ...extra
        });
        material.userData.pbrRepeat = { x: repeatX, y: repeatY };
        return material;
    };

    const materials = {
        platform: makeStoneMaterial(0x786a57, 2.8, 2.3),
        platformSide: makeStoneMaterial(0x55483f, 2.1, 1.2),
        underside: makeStoneMaterial(0x3e4148, 2.2, 1.1),
        floor: [
            makeStoneMaterial(0x88765f, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0x958065, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0x71675d, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0x81725f, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0x665f58, 1.15, 1.15, { side: THREE.DoubleSide }),
            makeStoneMaterial(0x756d5d, 1.15, 1.15, { side: THREE.DoubleSide })
        ],
        seam: new THREE.MeshBasicMaterial({ color: 0x201c1a }),
        metal: makeMaterial(0x302d31, 0.52, 0.72),
        metalEdge: makeMaterial(0x8b6944, 0.38, 0.72),
        column: makeStoneMaterial(0x746451, 1.3, 3.4),
        columnLight: makeStoneMaterial(0x9a8260, 1.5, 2.2),
        stone: [
            makeStoneMaterial(0x756451, 0.95, 0.95),
            makeStoneMaterial(0x8c765b, 0.95, 0.95),
            makeStoneMaterial(0x5c5b5e, 0.95, 0.95)
        ],
        floatingRock: [
            makeStoneMaterial(0x6b625b, 2.2, 2.2, { flatShading: true }),
            makeStoneMaterial(0x797064, 2.2, 2.2, { flatShading: true }),
            makeStoneMaterial(0x555861, 2.2, 2.2, { flatShading: true })
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

    const pbrMaterialTargets = {
        stone: new Set([
            materials.platform,
            materials.platformSide,
            ...materials.floor,
            materials.column,
            materials.columnLight,
            ...materials.stone
        ]),
        rock: new Set([
            materials.underside,
            ...materials.floatingRock
        ])
    };
    const pbrMaps = { stone: null, rock: null };
    const textureLoader = new THREE.TextureLoader();

    function loadPbrTexture(filename, colorSpace) {
        const url = new URL(`assets/pbr/${filename}`, document.baseURI).href;
        return new Promise((resolve) => {
            textureLoader.load(
                url,
                (texture) => {
                    texture.colorSpace = colorSpace;
                    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
                    texture.anisotropy = Math.min(
                        renderer.capabilities.getMaxAnisotropy(),
                        mobileQuality ? 4 : 8
                    );
                    resolve(texture);
                },
                undefined,
                (error) => {
                    console.error(`Unable to load the ${filename} scene texture.`, error);
                    resolve(null);
                }
            );
        });
    }

    async function loadPbrSet(prefix) {
        const [map, normalMap, roughnessMap] = await Promise.all([
            loadPbrTexture(`${prefix}-color.jpg`, THREE.SRGBColorSpace),
            loadPbrTexture(`${prefix}-normal.jpg`, THREE.NoColorSpace),
            loadPbrTexture(`${prefix}-roughness.jpg`, THREE.NoColorSpace)
        ]);
        if (!map || !normalMap || !roughnessMap) {
            [map, normalMap, roughnessMap].forEach((texture) => texture?.dispose());
            return null;
        }
        map.repeat.set(1.35, 1.35);
        normalMap.repeat.copy(map.repeat);
        roughnessMap.repeat.copy(map.repeat);
        return { map, normalMap, roughnessMap };
    }

    function applyPbrMaps(targets, maps) {
        if (!maps) return;
        for (const material of targets) {
            for (const property of ["map", "normalMap", "roughnessMap", "bumpMap"]) {
                const oldTexture = material[property];
                if (oldTexture && oldTexture !== stoneMaps.colorMap && oldTexture !== stoneMaps.heightMap) {
                    oldTexture.dispose();
                }
                const texture = maps[property]?.clone() ?? null;
                if (texture) {
                    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
                    texture.repeat.set(
                        material.userData.pbrRepeat?.x ?? 1.35,
                        material.userData.pbrRepeat?.y ?? 1.35
                    );
                    texture.needsUpdate = true;
                }
                material[property] = texture;
            }
            material.normalScale?.set(0.7, 0.7);
            material.needsUpdate = true;
        }
    }

    function registerPbrMaterial(material, materialType) {
        pbrMaterialTargets[materialType].add(material);
        if (pbrMaps[materialType]) {
            applyPbrMaps(new Set([material]), pbrMaps[materialType]);
        }
    }

    void Promise.all([loadPbrSet("stone"), loadPbrSet("rock")]).then(([stone, rock]) => {
        pbrMaps.stone = stone;
        pbrMaps.rock = rock;
        applyPbrMaps(pbrMaterialTargets.stone, stone);
        applyPbrMaps(pbrMaterialTargets.rock, rock);
    });

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

    function addContactShadow(parent, width, depth, y = 0.006) {
        const shadow = new THREE.Mesh(
            new THREE.PlaneGeometry(width, depth),
            contactShadowMaterial.clone()
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = y;
        shadow.renderOrder = 1;
        parent.add(shadow);
        return shadow;
    }

    function createFacetedCrystalGeometry(radius, height, segments = 6) {
        const rings = [
            { y: 0.2 * height, radius: 0.58 * radius },
            { y: 0.62 * height, radius },
            { y: 0.82 * height, radius: 0.56 * radius }
        ];
        const positions = [];
        const colors = [];
        const facetShades = [0.58, 0.82, 1.12, 0.72, 1];
        const addFace = (a, b, c, faceIndex) => {
            positions.push(...a, ...b, ...c);
            const shade = facetShades[faceIndex % facetShades.length];
            for (let vertex = 0; vertex < 3; vertex++) colors.push(shade, shade, shade);
        };
        const pointAt = (angle, ring) => [
            Math.cos(angle) * ring.radius,
            ring.y,
            Math.sin(angle) * ring.radius
        ];
        const bottom = [0, 0, 0];
        const top = [0, height, 0];
        let faceIndex = 0;

        for (let segment = 0; segment < segments; segment++) {
            const angleA = (segment / segments) * Math.PI * 2;
            const angleB = ((segment + 1) / segments) * Math.PI * 2;
            const firstRingA = pointAt(angleA, rings[0]);
            const firstRingB = pointAt(angleB, rings[0]);
            addFace(bottom, firstRingA, firstRingB, faceIndex++);

            for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex++) {
                const lowerA = pointAt(angleA, rings[ringIndex]);
                const lowerB = pointAt(angleB, rings[ringIndex]);
                const upperA = pointAt(angleA, rings[ringIndex + 1]);
                const upperB = pointAt(angleB, rings[ringIndex + 1]);
                addFace(lowerA, upperB, lowerB, faceIndex++);
                addFace(lowerA, upperA, upperB, faceIndex++);
            }

            addFace(pointAt(angleA, rings[2]), top, pointAt(angleB, rings[2]), faceIndex++);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
        geometry.computeVertexNormals();
        return geometry;
    }

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
        const beamCanvas = document.createElement("canvas");
        beamCanvas.width = 128;
        beamCanvas.height = 512;
        const beamContext = beamCanvas.getContext("2d");
        const beamImage = beamContext.createImageData(beamCanvas.width, beamCanvas.height);
        for (let y = 0; y < beamCanvas.height; y++) {
            const vertical = 0.16 * Math.pow(1 - y / beamCanvas.height, 0.75);
            for (let x = 0; x < beamCanvas.width; x++) {
                const horizontal = Math.exp(-Math.pow((x / beamCanvas.width - 0.5) / 0.2, 2));
                const offset = (y * beamCanvas.width + x) * 4;
                beamImage.data[offset] = 220;
                beamImage.data[offset + 1] = 226;
                beamImage.data[offset + 2] = 235;
                beamImage.data[offset + 3] = Math.round(vertical * horizontal * 255);
            }
        }
        beamContext.putImageData(beamImage, 0, 0);
        const beamTexture = new THREE.CanvasTexture(beamCanvas);
        const beamMaterial = new THREE.MeshBasicMaterial({
            map: beamTexture,
            color: 0x9caec2,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
            side: THREE.DoubleSide
        });
        [
            { x: -5.3, y: 4.7, z: -7.8, width: 3.2, rotation: 0.35 },
            { x: 1.8, y: 4.9, z: -8.5, width: 2.6, rotation: 0.68 }
        ].forEach(({ x, y, z, width, rotation }) => {
            const beam = new THREE.Mesh(new THREE.PlaneGeometry(width, 11), beamMaterial);
            beam.position.set(x, y, z);
            beam.rotation.y = rotation;
            beam.renderOrder = 0;
            scene.add(beam);
        });

        const dustPositions = [];
        let seed = 7812;
        const random = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        for (let i = 0; i < 480; i++) {
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
            new THREE.PointsMaterial({ color: 0xc5d4e5, size: 0.03, transparent: true, opacity: 0.38 })
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
        createIslandKeel();

        const edgeBand = makeMaterial(0x786a58, 0.92, 0.04);
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
                edgeBand
            );
            platform.add(mesh);
        });

        const underglow = configureQualityLight(new THREE.PointLight(0x274867, 20, 14, 2));
        underglow.position.set(0, -1.8, 0);
        platform.add(underglow);

        const rockGeometry = new THREE.IcosahedronGeometry(1, 2);
        const rockPositions = rockGeometry.attributes.position;
        for (let i = 0; i < rockPositions.count; i++) {
            const x = rockPositions.getX(i);
            const y = rockPositions.getY(i);
            const z = rockPositions.getZ(i);
            const variation = 0.84 +
                Math.sin(x * 13.7 + z * 8.3 + y * 5.1) * 0.1 +
                Math.cos(z * 17.1 - y * 9.2) * 0.07;
            rockPositions.setXYZ(
                i,
                x * variation,
                y * (0.9 + Math.sin(x * 11.3 + z * 4.7) * 0.12),
                z * variation
            );
        }
        rockGeometry.computeVertexNormals();
        const floatingRocks = [
            [-5.5, -2.25, -2.6, 1.65, 1.35, 1.5],
            [-4.3, -2.75, 2.8, 1.45, 1.8, 1.25],
            [-2.7, -2.3, -3.75, 1.7, 1.55, 1.4],
            [-1.25, -2.75, 4.0, 1.35, 1.6, 1.3],
            [0.35, -2.35, -4.05, 1.8, 1.35, 1.45],
            [2.35, -2.8, 3.75, 1.55, 1.8, 1.4],
            [4.1, -2.25, -3.25, 1.65, 1.45, 1.5],
            [5.0, -2.7, 1.65, 1.45, 1.8, 1.35],
            [-5.3, -3.15, 0.2, 1.3, 1.9, 1.25],
            [3.2, -3.2, -0.65, 1.4, 1.85, 1.3]
        ];
        floatingRocks.forEach(([x, y, z, scaleX, scaleY, scaleZ], index) => {
            const rock = new THREE.Mesh(
                rockGeometry,
                materials.floatingRock[index % materials.floatingRock.length]
            );
            rock.position.set(x, y, z);
            rock.scale.set(scaleX, scaleY, scaleZ);
            rock.rotation.set(index * 0.11, index * 0.71, index * -0.09);
            rock.castShadow = true;
            rock.receiveShadow = true;
            platform.add(rock);
        });
        createFracturedFloor();
    }

    function createIslandKeel() {
        const rings = [
            { y: -1.75, radius: 5.15 },
            { y: -2.08, radius: 4.72 },
            { y: -2.42, radius: 4.48 },
            { y: -2.56, radius: 3.96 },
            { y: -3.08, radius: 3.74 },
            { y: -3.22, radius: 3.22 },
            { y: -3.76, radius: 2.96 },
            { y: -3.94, radius: 2.5 },
            { y: -4.45, radius: 2.14 },
            { y: -4.62, radius: 1.72 },
            { y: -5.12, radius: 1.25 },
            { y: -5.38, radius: 0.83 },
            { y: -5.82, radius: 0.38 },
            { y: -6.05, radius: 0.12 }
        ];
        const segments = 48;
        const positions = [];
        const colors = [];
        const uvs = [];
        const strata = [0x9b8064, 0x857566, 0x69646a, 0x98846a, 0x706b68, 0x505762];
        let seed = 62041;
        const random = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        const points = rings.map(({ y, radius }, ringIndex) =>
            Array.from({ length: segments }, (_, segment) => {
                const angle = segment / segments * Math.PI * 2;
                const irregularity = 0.79 + random() * 0.42;
                return [
                    Math.cos(angle) * radius * irregularity,
                    y + (ringIndex === 0 ? 0 : (random() - 0.5) * 0.34),
                    Math.sin(angle) * radius * irregularity
                ];
            })
        );
        const appendFace = (a, b, c, baseColor) => {
            positions.push(...a, ...b, ...c);
            const faceUvs = [a, b, c].map(([x, y, z]) => [
                Math.atan2(z, x) / (Math.PI * 2) + 0.5,
                (y + 6.05) / 4.3
            ]);
            const uValues = faceUvs.map(([u]) => u);
            if (Math.max(...uValues) - Math.min(...uValues) > 0.5) {
                for (const uv of faceUvs) {
                    if (uv[0] < 0.5) uv[0] += 1;
                }
            }
            for (const [u, v] of faceUvs) uvs.push(u, v);
            const shade = 0.82 + random() * 0.3;
            const color = new THREE.Color(baseColor).multiplyScalar(shade);
            for (let vertex = 0; vertex < 3; vertex++) {
                colors.push(color.r, color.g, color.b);
            }
        };

        for (let ring = 0; ring < rings.length - 1; ring++) {
            for (let segment = 0; segment < segments; segment++) {
                const next = (segment + 1) % segments;
                const upper = points[ring];
                const lower = points[ring + 1];
                const color = strata[(ring + Math.floor(random() * 2)) % strata.length];
                appendFace(upper[segment], upper[next], lower[next], color);
                appendFace(upper[segment], lower[next], lower[segment], color);
            }
        }

        const tip = [0, -6.05, 0];
        const bottomRing = points[points.length - 1];
        for (let segment = 0; segment < segments; segment++) {
            appendFace(bottomRing[segment], bottomRing[(segment + 1) % segments], tip, strata[5]);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
        geometry.computeVertexNormals();
        const keelMaterial = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            emissive: 0x282724,
            emissiveIntensity: 0.48,
            roughness: 0.98,
            metalness: 0.01,
            flatShading: true,
            vertexColors: true
        });
        registerPbrMaterial(keelMaterial, "rock");
        const keel = new THREE.Mesh(geometry, keelMaterial);
        keel.castShadow = true;
        keel.receiveShadow = true;
        platform.add(keel);
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
        const seamVertices = [];

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
                const shrink = 0.07 + random() * 0.035;
                const corners = quad.map(([x, z]) => [
                    cx + (x - cx) * (1 - shrink),
                    cz + (z - cz) * (1 - shrink)
                ]);
                const plate = [];
                corners.forEach((corner, index) => {
                    const previous = corners[(index + corners.length - 1) % corners.length];
                    const next = corners[(index + 1) % corners.length];
                    const cutIn = 0.12 + random() * 0.12;
                    const cutOut = 0.12 + random() * 0.12;
                    plate.push(
                        [
                            corner[0] + (previous[0] - corner[0]) * cutIn,
                            corner[1] + (previous[1] - corner[1]) * cutIn
                        ],
                        [
                            corner[0] + (next[0] - corner[0]) * cutOut,
                            corner[1] + (next[1] - corner[1]) * cutOut
                        ]
                    );
                });
                const floorMaterial = materials.floor[Math.floor(random() * materials.floor.length)];
                const tile = extrudedPolygon(
                    platform,
                    plate,
                    0.16 + random() * 0.045,
                    -0.06,
                    floorMaterial,
                    0.045
                );
                tile.position.y += (random() - 0.5) * 0.1;

                for (let i = 0; i < plate.length; i++) {
                    const a = plate[i];
                    const b = plate[(i + 1) % plate.length];
                    seamVertices.push(a[0], 0.15, a[1], b[0], 0.15, b[1]);
                }
            }
        }

        const seamGeometry = new THREE.BufferGeometry();
        seamGeometry.setAttribute("position", new THREE.Float32BufferAttribute(seamVertices, 3));
        platform.add(new THREE.LineSegments(seamGeometry, materials.seam));
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
        const crackVertices = [];
        paths.forEach((path) => {
            for (let i = 0; i < path.length - 1; i++) {
                const [x1, z1] = path[i];
                const [x2, z2] = path[i + 1];
                crackVertices.push(x1, 0.195, z1, x2, 0.195, z2);
            }
        });
        const crackGeometry = new THREE.BufferGeometry();
        crackGeometry.setAttribute("position", new THREE.Float32BufferAttribute(crackVertices, 3));
        platform.add(new THREE.LineSegments(crackGeometry, materials.seam));

        const seamMat = new THREE.MeshBasicMaterial({ color: 0x252321 });
        const fracturedSeamVertices = [];
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
                fracturedSeamVertices.push(x1, 0.19, z1, x2, 0.19, z2);
            }
        });
        const fracturedSeamGeometry = new THREE.BufferGeometry();
        fracturedSeamGeometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(fracturedSeamVertices, 3)
        );
        platform.add(new THREE.LineSegments(fracturedSeamGeometry, seamMat));
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
            const x = gridX(GRID.start.col) + launchDirection * 0.45;
            const z = gridZ(GRID.start.row);
            marker.position.set(x, 0.25, z);
            hitArea.position.set(x, 0.29, z);
            sourcePylon?.position.set(x, 0, z);
            if (sourcePylon?.userData.wallEmitter) {
                sourcePylon.userData.wallEmitter.position.x = -launchDirection * 0.3;
                sourcePylon.userData.emitterRing.position.x = launchDirection * 0.2;
                sourcePylon.userData.emitterRing.rotation.y = launchDirection === 1
                    ? Math.PI / 2
                    : -Math.PI / 2;
                sourcePylon.userData.emitterCore.position.x = launchDirection * 0.2;
                sourcePylon.userData.beaconLight.position.x = launchDirection * 0.22;
            }
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
        const lineMaterial = makeMaterial(0x39352f, 0.98, 0, {
            transparent: true,
            opacity: 0.2
        });
        const lineWidth = 0.009;
        const lineHeight = 0.006;
        const left = gridX(0) - GRID.step / 2;
        const right = gridX(GRID.cols - 1) + GRID.step / 2;
        const back = gridZ(0) - GRID.step / 2;
        const front = gridZ(GRID.rows - 1) + GRID.step / 2;
        const y = 0.19;

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
        addContactShadow(group, 1.05, 0.82, 0.006);
        const baseMaterial = makeMaterial(0x26313d, 0.38, 0.82);
        const frameMaterial = makeMaterial(0xa6b8b8, 0.25, 0.84, {
            emissive: 0x173b4a,
            emissiveIntensity: 0.18
        });
        const glassMaterial = new THREE.MeshStandardMaterial({
            color: 0xbaf5ff,
            emissive: 0x168db6,
            emissiveIntensity: 0.82,
            metalness: 0.72,
            roughness: 0.12,
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

        const mount = configureQualityLight(new THREE.PointLight(0x42d7ff, 2, 1.4, 2));
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
                if (!object.isMesh && !object.isLine && !object.isSprite) return;
                if (object.isSprite) object.material?.map?.dispose();
                object.geometry?.dispose();
                if (Array.isArray(object.material)) {
                    object.material.forEach((material) => material.dispose());
                } else {
                    object.material?.dispose();
                }
            });
        }
    }

    const beamColors = [colors.pink, colors.amber, colors.blue];
    const crystalColors = [0xff77e6, 0xffaa43, 0x43baff];

    function traceLight() {
        const mirrorOrientations = new Map(
            [...placedMirrors].map(([key, mirror]) => [key, mirror.slash ? "/" : "\\"])
        );
        const route = traceLaserRoute(activeLevel, mirrorOrientations, launchDirection);
        const segments = route.segments.map((segment) => {
            const from = segment.from.col < 0 || segment.from.col >= GRID.cols
                ? new THREE.Vector3(
                    gridX(segment.from.col) + (launchDirection === 1 ? 0.37 : -0.37),
                    0.82,
                    gridZ(segment.from.row)
                )
                : new THREE.Vector3(gridX(segment.from.col), 0.72, gridZ(segment.from.row));
            const directionRow = segment.to.row - segment.from.row;
            const directionCol = segment.to.col - segment.from.col;
            const to = segment.exitsBoard
                ? from.clone().add(new THREE.Vector3(directionCol, 0, directionRow).multiplyScalar(GRID.step * 0.68))
                : new THREE.Vector3(
                    gridX(segment.to.col),
                    segment.to.row === GRID.target.row && segment.to.col === GRID.target.col
                        ? CORE_CONTACT_HEIGHT
                        : 0.72,
                    gridZ(segment.to.row)
                );
            return {
                from,
                to,
                color: beamColors[segment.colorIndex % beamColors.length]
            };
        });
        return { ...route, segments };
    }

    function addActiveSegment(segment, index, visibleCount, preview = false) {
        const curve = new THREE.LineCurve3(segment.from, segment.to);
        const halo = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 1, 0.14, 8, false),
            new THREE.MeshBasicMaterial({
                color: segment.color,
                transparent: true,
                opacity: preview ? 0.1 : 0.2,
                depthWrite: false,
                toneMapped: false,
                blending: THREE.AdditiveBlending
            })
        );
        const glow = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 1, 0.052, 8, false),
            new THREE.MeshBasicMaterial({
                color: segment.color,
                transparent: true,
                opacity: preview ? 0.34 : 0.62,
                depthWrite: false,
                toneMapped: false,
                blending: THREE.AdditiveBlending
            })
        );
        const core = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 1, 0.014, 6, false),
            new THREE.MeshBasicMaterial({
                color: 0xe5fbff,
                transparent: preview,
                opacity: preview ? 0.84 : 1,
                depthWrite: !preview,
                toneMapped: false,
                blending: THREE.AdditiveBlending
            })
        );
        halo.visible = index < visibleCount;
        glow.visible = index < visibleCount;
        core.visible = index < visibleCount;
        activeBeamGroup.add(halo, glow, core);
        beamSegments.push({ halo, glow, core });
    }

    function drawActiveRoute(route, visibleCount = route.segments.length, preview = false) {
        clearObjectGroup(activeBeamGroup);
        beamSegments.length = 0;
        route.segments.forEach((segment, index) => addActiveSegment(segment, index, visibleCount, preview));
    }

    function placeLevelTarget() {
        coreSystem.scale.setScalar(CORE_SCALE);
        coreSystem.position.set(
            gridX(GRID.target.col) - 1.35 * CORE_SCALE,
            0,
            gridZ(GRID.target.row) - 0.1 * CORE_SCALE
        );
        coreActivationGroup.position.set(gridX(GRID.target.col), 0, gridZ(GRID.target.row));
        coreLight.position.set(gridX(GRID.target.col), 1.5, gridZ(GRID.target.row));
    }

    function createLevelObstacles() {
        clearObjectGroup(levelObjectGroup);
        levelCrystals.clear();
        activeLevel.obstacles.forEach(({ row, col }, index) => {
            const block = new THREE.Group();
            block.position.set(gridX(col), 0.19, gridZ(row));
            levelObjectGroup.add(block);
            const width = index % 3 === 0 ? 0.92 : 0.76;
            addContactShadow(block, width * 1.5, width * 1.35, 0.006);
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
        activeLevel.crystals.forEach((definition, index) => {
            const cellKey = gridKey(definition.row, definition.col);
            const crystalGroup = new THREE.Group();
            crystalGroup.position.set(gridX(definition.col), 0.2, gridZ(definition.row));
            levelObjectGroup.add(crystalGroup);
            const crystalLight = new THREE.PointLight(
                crystalColors[definition.inputColor],
                mobileQuality ? 2.2 : 4.5,
                mobileQuality ? 3.2 : 4.5,
                2
            );
            crystalLight.position.set(0, 0.58, 0);
            crystalGroup.add(crystalLight);
            addContactShadow(crystalGroup, 0.95, 0.95, 0.006);

            const pedestalMetal = materials.metal.clone();
            const pedestalStone = materials.columnLight.clone();
            addCylinder(crystalGroup, 0.42, 0.48, 0.12, [0, -0.12, 0], pedestalMetal, 12);
            addCylinder(crystalGroup, 0.34, 0.42, 0.12, [0, 0, 0], pedestalStone, 10);
            addCylinder(crystalGroup, 0.3, 0.34, 0.055, [0, 0.08, 0], pedestalMetal, 24);
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(0.36, 0.026, 6, 32),
                new THREE.MeshStandardMaterial({
                    color: crystalColors[definition.inputColor],
                    emissive: crystalColors[definition.inputColor],
                    emissiveIntensity: 1.45,
                    metalness: 0.62,
                    roughness: 0.24,
                    transparent: true,
                    opacity: 0.88
                })
            );
            ring.rotation.x = Math.PI / 2;
            ring.position.y = 0.115;
            crystalGroup.add(ring);

            const material = new THREE.MeshPhysicalMaterial({
                color: crystalColors[definition.inputColor],
                emissive: crystalColors[definition.inputColor],
                emissiveIntensity: 0.82,
                metalness: 0.16,
                roughness: 0.12,
                clearcoat: 0.82,
                clearcoatRoughness: 0.08,
                flatShading: true,
                vertexColors: true
            });
            const prism = new THREE.Group();
            const shards = [
                { x: 0, z: 0, height: 0.91, radius: 0.25 },
                { x: -0.23, z: 0.04, height: 0.58, radius: 0.15 },
                { x: 0.22, z: 0.06, height: 0.64, radius: 0.16 },
                { x: -0.08, z: -0.22, height: 0.52, radius: 0.14 },
                { x: 0.1, z: 0.22, height: 0.57, radius: 0.145 }
            ];
            shards.forEach((shard, shardIndex) => {
                const crystal = new THREE.Mesh(
                    createFacetedCrystalGeometry(shard.radius, shard.height, 5),
                    material
                );
                crystal.position.set(shard.x, 0.11, shard.z);
                crystal.rotation.y = (shardIndex * Math.PI) / 5 + index * 0.23;
                crystal.castShadow = true;
                prism.add(crystal);
            });
            crystalGroup.add(prism);
            const labelCanvas = document.createElement("canvas");
            labelCanvas.width = 128;
            labelCanvas.height = 56;
            const labelContext = labelCanvas.getContext("2d");
            labelContext.fillStyle = "#08131ee8";
            labelContext.fillRect(2, 2, 124, 52);
            labelContext.strokeStyle = "#b4eefa";
            labelContext.lineWidth = 3;
            labelContext.strokeRect(3.5, 3.5, 121, 49);
            labelContext.fillStyle = "#e8fbff";
            labelContext.font = "bold 32px Consolas, monospace";
            labelContext.textAlign = "center";
            labelContext.textBaseline = "middle";
            labelContext.fillText(String(index + 1).padStart(2, "0"), 64, 29);
            const labelTexture = new THREE.CanvasTexture(labelCanvas);
            labelTexture.colorSpace = THREE.SRGBColorSpace;
            const label = new THREE.Sprite(new THREE.SpriteMaterial({
                map: labelTexture,
                transparent: true,
                depthWrite: false
            }));
            label.position.y = 1.02;
            label.scale.set(0.62, 0.27, 1);
            crystalGroup.add(label);
            levelCrystals.set(cellKey, {
                definition: { ...definition, index },
                material,
                ringMaterial: ring.material,
                light: crystalLight,
                prism,
                activated: false
            });
        });
    }

    function resetCrystalStates() {
        for (const crystal of levelCrystals.values()) {
            crystal.activated = false;
            crystal.material.emissiveIntensity = 0.68;
            crystal.material.color.setHex(crystalColors[crystal.definition.inputColor]);
            crystal.ringMaterial.color.setHex(crystalColors[crystal.definition.inputColor]);
            crystal.light.color.setHex(crystalColors[crystal.definition.inputColor]);
            crystal.prism.scale.setScalar(1);
        }
    }

    function loadLevel(levelDetails) {
        const level = levelDetails?.level ?? levelDetails;
        if (!level || !Number.isInteger(level.number) || level.number < 1 || level.number > levels.length) {
            console.error("Cannot load an invalid RelicGrid level.", level);
            return;
        }
        activeLevel = level;
        if (decorativeTerminalGroup) decorativeTerminalGroup.visible = false;
        firstLevelTutorial = level.number === 1 && levelDetails?.tutorial === true;
        firstLevelTutorialStage = "observe";
        const tutorialMirror = level.solutionMirrors[0];
        tutorialTargetMarker.visible = firstLevelTutorial && Boolean(tutorialMirror);
        if (tutorialMirror) {
            tutorialTargetMarker.position.x = gridX(tutorialMirror.col);
            tutorialTargetMarker.position.z = gridZ(tutorialMirror.row);
        }
        walletLevelSessionId = levelDetails?.level ? levelDetails.walletSessionId ?? null : null;
        walletLevelEntryCostCredits = levelDetails?.level
            ? levelDetails.entryCostCredits ?? null
            : null;
        gameAccessPointsUsed = levelDetails?.level
            ? levelDetails.gameAccessPointsUsed ?? null
            : null;
        gamePointsSession = levelDetails?.level
            ? levelDetails.gamePointsSession === true
            : false;
        GRID.start = { row: level.start.row, col: level.start.col };
        GRID.target = { row: level.target.row, col: level.target.col };
        launchDirection = level.start.direction;
        GRID.start.col = launchDirection === 1 ? -1 : GRID.cols;
        placeLevelTarget();
        createLevelObstacles();
        resetGame();
        updateSourceMarker();
        environmentNetwork.visible = false;
        statusTitle.textContent = `Level ${String(level.number).padStart(2, "0")} — ${level.title}`;
        document.getElementById("first-level-tutorial").hidden = !firstLevelTutorial;
        if (firstLevelTutorial) {
            updateFirstLevelTutorial(
                "01 / 03",
                "Place a mirror",
                "The live preview shows the beam leaving the source. Place a mirror at row " +
                    `${level.solutionMirrors[0].row + 1}, column ${level.solutionMirrors[0].col + 1}.`
            );
        }
    }

    function updateFirstLevelTutorial(step, title, instruction) {
        if (!firstLevelTutorial) return;
        document.getElementById("tutorial-step").textContent = `LIVE TUTORIAL · ${step}`;
        document.getElementById("tutorial-title").textContent = title;
        document.getElementById("tutorial-instruction").textContent = instruction;
    }

    function setCorePowered(powered) {
        const activated = powered && !corePowered;
        corePowered = powered;
        coreActivatedAt = powered ? performance.now() : null;
        coreActivationGroup.visible = powered;
        if (powered && activated) playSoundEffect("core");
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
        updateTacticalHud();
    }

    function setFeedback(message, kind = "") {
        statusText.textContent = message;
        statusText.dataset.state = kind;
        updateTacticalHud();
    }

    function updateTacticalHud() {
        const charged = [...levelCrystals.values()].filter((crystal) => crystal.activated).length;
        const totalCrystals = activeLevel.crystals.length;
        const mirrorCount = placedMirrors.size;
        const mirrorTarget = activeLevel.par;
        const crystalCount = document.getElementById("hud-crystal-count");
        const mirrorCountLabel = document.getElementById("hud-mirror-count");
        const crystalFill = document.getElementById("hud-crystal-fill");
        const mirrorFill = document.getElementById("hud-mirror-fill");
        const laserState = document.getElementById("hud-laser-state");
        const batteryState = document.getElementById("hud-battery-state");
        const coreIndicator = document.getElementById("hud-core-indicator");
        const telemetryLevel = document.getElementById("hud-telemetry-level");
        const telemetryCrystals = document.getElementById("hud-telemetry-crystals");
        const telemetryCrystalFill = document.getElementById("hud-telemetry-crystal-fill");
        const telemetryMirrors = document.getElementById("hud-telemetry-mirrors");
        const telemetryMirrorFill = document.getElementById("hud-telemetry-mirror-fill");
        const coreMirrorCount = document.getElementById("hud-core-mirror-count");
        const systemState = document.getElementById("hud-system-state");
        const mapLevel = document.getElementById("hud-map-level");
        const mapGrid = document.getElementById("hud-map-grid");
        const objectiveCrystals = document.getElementById("hud-objective-crystals");
        const objectiveBattery = document.getElementById("hud-objective-battery");
        if (!crystalCount || !mirrorCountLabel || !crystalFill || !mirrorFill ||
            !laserState || !batteryState || !coreIndicator || !telemetryLevel ||
            !telemetryCrystals || !telemetryCrystalFill || !telemetryMirrors ||
            !telemetryMirrorFill || !coreMirrorCount || !systemState ||
            !mapLevel || !mapGrid || !objectiveCrystals || !objectiveBattery) return;

        crystalCount.textContent = `${charged} / ${totalCrystals}`;
        mirrorCountLabel.textContent = `${mirrorCount} / ${mirrorTarget}`;
        coreMirrorCount.textContent = `${mirrorCount} / ${mirrorTarget}`;
        telemetryLevel.textContent = `${String(activeLevel.number).padStart(2, "0")} / 99`;
        telemetryCrystals.textContent = `${charged} / ${totalCrystals}`;
        telemetryMirrors.textContent = `${mirrorCount} / ${mirrorTarget}`;
        objectiveCrystals.textContent = `${charged} / ${totalCrystals}`;
        objectiveBattery.textContent = corePowered
            ? "CHARGED"
            : previewRoute?.outcome === "powered"
                ? "ROUTE SET"
                : "STANDBY";
        crystalFill.style.setProperty("--meter-fill", `${totalCrystals ? charged / totalCrystals * 100 : 0}%`);
        mirrorFill.style.setProperty("--meter-fill", `${mirrorTarget ? Math.min(mirrorCount / mirrorTarget, 1) * 100 : 0}%`);
        telemetryCrystalFill.style.width = `${totalCrystals ? charged / totalCrystals * 100 : 0}%`;
        telemetryMirrorFill.style.width = `${mirrorTarget ? Math.min(mirrorCount / mirrorTarget, 1) * 100 : 0}%`;
        const crystalTrack = crystalFill.parentElement;
        const mirrorTrack = mirrorFill.parentElement;
        const telemetryCrystalTrack = telemetryCrystalFill.parentElement;
        const telemetryMirrorTrack = telemetryMirrorFill.parentElement;
        crystalTrack.setAttribute("aria-valuenow", String(charged));
        crystalTrack.setAttribute("aria-valuemax", String(totalCrystals));
        mirrorTrack.setAttribute("aria-valuenow", String(mirrorCount));
        mirrorTrack.setAttribute("aria-valuemax", String(mirrorTarget));
        telemetryCrystalTrack.setAttribute("aria-valuenow", String(charged));
        telemetryCrystalTrack.setAttribute("aria-valuemax", String(totalCrystals));
        telemetryMirrorTrack.setAttribute("aria-valuenow", String(mirrorCount));
        telemetryMirrorTrack.setAttribute("aria-valuemax", String(mirrorTarget));
        const routeState = corePowered
            ? "ROUTE COMPLETE"
            : tracing
                ? "TRACING"
                : previewRoute?.outcome === "powered"
                    ? "ROUTE READY"
                    : previewRoute?.outcome === "blocked"
                        ? "BLOCKED"
                        : "PREVIEW";
        laserState.textContent = routeState;
        systemState.textContent = corePowered
            ? "ONLINE"
            : tracing
                ? "TRACING"
                : previewRoute?.outcome === "powered"
                    ? "ROUTE READY"
                    : "STANDBY";
        systemState.dataset.state = corePowered
            ? "online"
            : tracing
                ? "active"
                : previewRoute?.outcome === "blocked"
                    ? "blocked"
                    : "standby";
        batteryState.textContent = corePowered ? "CHARGED" : "TARGET";
        coreIndicator.dataset.state = corePowered ? "online" : tracing ? "active" : "standby";
        mapLevel.textContent = String(activeLevel.number).padStart(2, "0");
        mapGrid.setAttribute(
            "aria-label",
            `Level ${activeLevel.number} map: ${totalCrystals} crystals, ${activeLevel.obstacles.length} obstacles, battery target`
        );

        const obstacles = new Set(activeLevel.obstacles.map(({ row, col }) => gridKey(row, col)));
        const crystals = new Map(activeLevel.crystals.map((crystal, index) => [
            gridKey(crystal.row, crystal.col),
            index + 1
        ]));
        const sourceColumn = launchDirection === 1 ? 0 : GRID.cols - 1;
        const cells = [];
        for (let row = 0; row < GRID.rows; row++) {
            for (let col = 0; col < GRID.cols; col++) {
                const key = gridKey(row, col);
                const mirror = placedMirrors.get(key);
                const crystalNumber = crystals.get(key);
                const isTarget = row === GRID.target.row && col === GRID.target.col;
                const isSourceEdge = row === GRID.start.row && col === sourceColumn;
                let cellClass = "hud-map-cell";
                let label = "Open tile";
                if (isTarget) {
                    cellClass += " is-target";
                    label = "Battery";
                } else if (crystalNumber) {
                    cellClass += " is-crystal";
                    label = `Crystal ${crystalNumber}`;
                } else if (mirror) {
                    cellClass += " is-mirror";
                    label = `Mirror ${mirror.slash ? "/" : "\\\\"}`;
                } else if (obstacles.has(key)) {
                    cellClass += " is-obstacle";
                    label = "Stone obstacle";
                } else if (isSourceEdge) {
                    cellClass += " is-source";
                    label = "Laser source edge";
                }
                cells.push(`<span class="${cellClass}" title="${label}" aria-hidden="true"></span>`);
            }
        }
        mapGrid.innerHTML = cells.join("");
    }

    function startSolveTimer() {
        if (levelStartedAt === null) {
            levelStartedAt = performance.now();
            if (walletLevelSessionId) {
                window.dispatchEvent(new CustomEvent("fluxgrid:level-timer-start", {
                    detail: { walletSessionId: walletLevelSessionId, gamePointsSession }
                }));
            }
        }
    }

    function showCompletionSummary(level, elapsedMilliseconds, result) {
        const timeTargets = level.starTimeTargets;
        const stars = result.stars;
        document.getElementById("completion-stars").textContent = `${stars} / 3`;
        document.getElementById("completion-star-icons").textContent = `${"★".repeat(stars)}${"☆".repeat(3 - stars)}`;
        document.getElementById("completion-level").textContent = `Level ${String(level.number).padStart(2, "0")}`;
        document.getElementById("completion-points").textContent =
            walletLevelSessionId || gameAccessPointsUsed ? "Pending" : "0";
        document.getElementById("completion-points-note").textContent = walletLevelSessionId
            ? "Awaiting server confirmation"
            : gameAccessPointsUsed
                ? "Campaign progress saves on this device"
                : "Practice clear · not saved";
        document.getElementById("completion-time").textContent = `${(elapsedMilliseconds / 1000).toFixed(1)} s`;
        document.getElementById("completion-time-thresholds").textContent =
            `3★ ≤ ${timeTargets.threeSeconds}s · 2★ ≤ ${timeTargets.twoSeconds}s`;
        const formattedEntryCost = Number.isSafeInteger(gameAccessPointsUsed)
            ? `${gameAccessPointsUsed.toLocaleString("en-US")} game points`
            : Number.isSafeInteger(walletLevelEntryCostCredits)
                ? `${walletLevelEntryCostCredits.toLocaleString("en-US")} credits`
                : "Unavailable";
        document.getElementById("completion-entry-cost").textContent = formattedEntryCost;
        document.querySelector("#completion-entry-cost + small").textContent =
            gameAccessPointsUsed
                ? "Used once when this level started"
                : "Deducted once when the server session began";

        const rewardLabel = document.getElementById("completion-reward-label");
        const reward = document.getElementById("completion-reward");
        const rewardNote = document.getElementById("completion-reward-note");
        if (gameAccessPointsUsed && !gamePointsSession) {
            rewardLabel.textContent = "NO WALLET REWARD";
            reward.textContent = "—";
            rewardNote.textContent = "Game access points are separate from wallet credits";
            document.getElementById("completion-token-reward").textContent = "NONE";
            document.getElementById("completion-balance").textContent = "Unchanged";
            document.getElementById("completion-balance-note").textContent = "Wallet balance unchanged";
        } else {
            rewardLabel.textContent = gamePointsSession ? "ESTIMATED POINT REWARD" : "ESTIMATED REWARD";
            reward.textContent = `${result.rewardCredits.toLocaleString("en-US")} ${gamePointsSession ? "points" : "credits"}`;
            rewardNote.textContent = "Pending server confirmation; not yet credited";
            document.getElementById("completion-token-reward").textContent = "NONE";
            document.getElementById("completion-balance").textContent = "Not confirmed";
            document.getElementById("completion-balance-note").textContent =
                gamePointsSession
                    ? "Points balance refreshes after server confirmation"
                    : "Refreshes only after backend confirmation";
        }
        const nextLevelButton = document.getElementById("next-level");
        nextLevelButton.hidden = false;
        nextLevelButton.disabled = true;
        nextLevelButton.dataset.nextLevel = String(level.number + 1);
        nextLevelButton.textContent = level.number >= levels.length ? "CAMPAIGN COMPLETE" : "NEXT LEVEL →";
        completionSummary.hidden = false;
        gameHud.dataset.completed = "true";
    }

    function finishLevelCompletion(pending) {
        if (pendingLevelCompletion !== pending) return;
        pendingLevelCompletion = null;
        showCompletionSummary(pending.level, pending.elapsedMilliseconds, pending.result);
        const starLabel = pending.result.stars === 3
            ? "3 stars"
            : pending.result.stars === 2
                ? "2 stars"
                : "1 star";
        setStatus(
            "Battery connected",
            gameAccessPointsUsed && !gamePointsSession
                ? `Level ${String(pending.level.number).padStart(2, "0")} complete. Rating: ${starLabel}.`
                : `Level ${String(pending.level.number).padStart(2, "0")} complete. Rating: ${starLabel}. Reward pending server calculation.`,
            "success"
        );
        window.dispatchEvent(new CustomEvent("fluxgrid:level-complete", { detail: pending.detail }));
    }

    function placeOrRotateMirror(row, col) {
        if (tracing || corePowered) return;
        if ((row === GRID.start.row && col === GRID.start.col) ||
            (row === GRID.target.row && col === GRID.target.col)) {
            setFeedback("The source and battery occupy those tiles.");
            return;
        }
        if (levelCrystals.has(gridKey(row, col))) {
            setFeedback("A crystal occupies this tile. Route the laser through it; mirrors cannot cover crystals.");
            return;
        }
        startSolveTimer();
        resetCrystalStates();
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
        playSoundEffect("mirror");

        clearObjectGroup(activeBeamGroup);
        beamSegments.length = 0;
        previewRoute = traceLight();
        drawActiveRoute(previewRoute, previewRoute.segments.length, true);
        if (firstLevelTutorial && firstLevelTutorialStage !== "complete") {
            const tutorialMirror = activeLevel.solutionMirrors[0];
            if (row !== tutorialMirror.row || col !== tutorialMirror.col) {
                firstLevelTutorialStage = "place";
                tutorialTargetMarker.visible = true;
                updateFirstLevelTutorial(
                    "01 / 03",
                    "Use the highlighted mirror tile",
                    `The highlighted row ${tutorialMirror.row + 1}, column ${tutorialMirror.col + 1} redirects the beam toward the crystal.`
                );
            } else if (previewRoute.outcome === "powered") {
                firstLevelTutorialStage = "launch";
                tutorialTargetMarker.visible = false;
                updateFirstLevelTutorial(
                    "03 / 03",
                    "Crystal and battery aligned",
                    "The preview now crosses the crystal and reaches the battery. Press POWER SOURCE to watch the full route."
                );
            } else {
                firstLevelTutorialStage = "rotate";
                tutorialTargetMarker.visible = false;
                updateFirstLevelTutorial(
                    "02 / 03",
                    "Rotate to redirect",
                    "Tap this mirror again. Watch the live beam preview change; stop when it passes the crystal and points to the battery."
                );
            }
        }
        if (previewRoute.outcome === "powered") {
            setFeedback(`All ${activeLevel.crystals.length} crystals aligned. Press POWER SOURCE to launch.`, "ready");
        } else if (previewRoute.outcome === "underpowered") {
            const needed = activeLevel.par - previewRoute.reflections;
            setFeedback(
                `Battery reached, but this sector requires ${activeLevel.par} mirrors on the beam path. Add ${needed} more.`,
                "miss"
            );
        } else if (previewRoute.outcome === "loop") {
            setFeedback("This route loops. Rotate or move a mirror before launching.", "miss");
        } else if (previewRoute.outcome === "crystal_missed") {
            const remaining = activeLevel.crystals.length - previewRoute.crystalHits.length;
            setFeedback(
                `Battery reached, but ${remaining} crystal${remaining === 1 ? " is" : "s are"} still uncharged. Redirect through every crystal.`,
                "miss"
            );
        } else if (previewRoute.outcome === "crystal_mismatch") {
            setFeedback("A crystal received the wrong beam color. Re-route through the crystals in sequence.", "miss");
        } else if (previewRoute.outcome === "crystal_order_mismatch") {
            setFeedback("The beam reached a crystal out of order. Route through the next numbered crystal.", "miss");
        } else if (previewRoute.outcome === "blocked") {
            setFeedback("Stone blocks the beam. Redirect it with a mirror before the obstruction.", "miss");
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
        GRID.start.col = launchDirection === 1 ? -1 : GRID.cols;
        updateSourceMarker();
        clearObjectGroup(activeBeamGroup);
        beamSegments.length = 0;
        previewRoute = placedMirrors.size ? traceLight() : null;
        resetCrystalStates();
        if (previewRoute) drawActiveRoute(previewRoute, previewRoute.segments.length, true);
        setFeedback(
            `Source points ${launchDirection === 1 ? "right" : "left"}. Place mirrors, then press POWER SOURCE to launch.`
        );
    }

    function animateTrace() {
        if (tracing || corePowered) return;
        startSolveTimer();
        previewRoute = traceLight();
        resetCrystalStates();
        environmentNetwork.visible = false;
        drawActiveRoute(previewRoute, 0);
        if (sourcePylon?.userData.beaconLight) sourcePylon.userData.beaconLight.intensity = 12;
        tracing = true;
        traceStartedAt = performance.now();
        traceResult = previewRoute;
        playSoundEffect("laser");
        if (firstLevelTutorial && firstLevelTutorialStage !== "complete") {
            updateFirstLevelTutorial(
                "03 / 03",
                "Follow the live beam",
                "Watch the beam travel through the crystal. The battery only lights when the required route is complete."
            );
        }
        traceButton.disabled = true;
        traceButton.innerHTML = "<span>…</span> TRACING";
        setStatus("Power source activated", "Tracing the live light path through your reflectors…");
    }

    function resetGame() {
        tracing = false;
        traceResult = null;
        if (pendingLevelCompletion) {
            window.dispatchEvent(new CustomEvent("fluxgrid:core-activation-cancel"));
        }
        pendingLevelCompletion = null;
        previewRoute = null;
        levelStartedAt = null;
        powerSourceSoundPlayed = false;
        completionSummary.hidden = true;
        const nextLevelButton = document.getElementById("next-level");
        nextLevelButton.hidden = true;
        nextLevelButton.disabled = true;
        resetCrystalStates();
        delete gameHud.dataset.completed;
        launchDirection = activeLevel.start.direction;
        GRID.start.col = launchDirection === 1 ? -1 : GRID.cols;
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
        const crystalObjective = activeLevel.crystals.length === 1
            ? "the numbered crystal"
            : `all ${activeLevel.crystals.length} numbered crystals`;
        setStatus(
            `Level ${String(activeLevel.number).padStart(2, "0")} — ${activeLevel.title}`,
            `Objective: aim through ${crystalObjective} in order, then reach the battery. Tap tiles to place or rotate mirrors; every reflection shifts beam color. Follow the live preview and press POWER SOURCE to launch.`
        );
        previewRoute = traceLight();
        drawActiveRoute(previewRoute, previewRoute.segments.length, true);
        if (firstLevelTutorial) {
            firstLevelTutorialStage = "observe";
            const tutorialMirror = activeLevel.solutionMirrors[0];
            tutorialTargetMarker.visible = true;
            updateFirstLevelTutorial(
                "01 / 03",
                "Place a mirror",
                `The preview shows the beam leaving the source. Place a mirror at row ${tutorialMirror.row + 1}, column ${tutorialMirror.col + 1}.`
            );
        }
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
        const columnScale = 0.58;
        const platformFloorY = 0.08;
        const islandUndersideY = -1.9;
        const columns = [
            [-3.4, -4.9, 9.6, 0.56],
            [0, -4.55, 10.4, 0.62],
            [3.2, -4.35, 9.4, 0.58],
            [-6.65, -2, 8.8, 0.66],
            [6.15, -1.7, 9, 0.68],
            [-5.1, 3.65, 8, 0.58],
            [4.5, 3.5, 8.3, 0.62]
        ];

        columns.forEach(([x, z, height, radius], i) => {
            const baseY = platformFloorY + 0.34 * columnScale / 2;
            const columnGroup = new THREE.Group();
            columnGroup.position.set(x, baseY, z);
            columnGroup.scale.setScalar(columnScale);
            world.add(columnGroup);

            addCylinder(
                columnGroup,
                radius * 1.52,
                radius * 1.72,
                0.34,
                [0, 0, 0],
                materials.stone[i % materials.stone.length],
                8
            );
            addCylinder(
                columnGroup,
                radius * 1.26,
                radius * 1.52,
                0.17,
                [0, 0.24, 0],
                materials.columnLight,
                8
            );
            addCylinder(
                columnGroup,
                radius * 1.08,
                radius * 1.24,
                0.14,
                [0, 0.38, 0],
                materials.stone[(i + 1) % materials.stone.length],
                12
            );
            [0.17, 0.33, 0.44].forEach((y, bandIndex) => {
                const band = new THREE.Mesh(
                    new THREE.TorusGeometry(radius * [1.46, 1.27, 1.12][bandIndex], 0.035, 6, 24),
                    bandIndex === 1 ? materials.metalEdge : materials.columnLight
                );
                band.rotation.x = Math.PI / 2;
                band.position.y = y;
                band.castShadow = true;
                columnGroup.add(band);
            });

            const shaftGeometry = new THREE.CylinderGeometry(
                radius * 0.82,
                radius,
                height,
                32,
                24,
                false
            );
            const shaftPositions = shaftGeometry.attributes.position;
            for (let vertex = 0; vertex < shaftPositions.count; vertex++) {
                const x = shaftPositions.getX(vertex);
                const y = shaftPositions.getY(vertex);
                const z = shaftPositions.getZ(vertex);
                const angle = Math.atan2(z, x);
                const heightRatio = y / height + 0.5;
                const flute = Math.cos(angle * 12 + i * 0.31) * 0.065;
                const weathering = Math.sin(angle * 3 + heightRatio * 6 + i) * 0.016;
                const radialScale = 1 + flute + weathering;
                shaftPositions.setXYZ(
                    vertex,
                    x * radialScale,
                    y + Math.sin(angle * 5 + heightRatio * 11) * 0.012,
                    z * radialScale
                );
            }
            shaftGeometry.computeVertexNormals();
            const shaft = new THREE.Mesh(shaftGeometry, materials.column);
            shaft.position.y = height / 2 + 0.3;
            shaft.castShadow = true;
            shaft.receiveShadow = true;
            columnGroup.add(shaft);

            const supportBottom = (islandUndersideY - 0.18 - baseY) / columnScale;
            const supportHeight = 0.3 - supportBottom;
            const islandSupport = new THREE.Mesh(
                new THREE.CylinderGeometry(radius * 0.72, radius * 0.9, supportHeight, 20, 8),
                materials.column
            );
            islandSupport.position.y = (0.3 + supportBottom) / 2;
            islandSupport.castShadow = true;
            islandSupport.receiveShadow = true;
            columnGroup.add(islandSupport);

            for (let band = 0; band < 5; band++) {
                const y = 0.52 + height * (band + 1) / 6;
                const collar = new THREE.Mesh(
                    new THREE.CylinderGeometry(radius * 0.94, radius * 1.01, 0.13, 20),
                    band % 2 === 0 ? materials.metalEdge : materials.columnLight
                );
                collar.position.y = y;
                collar.castShadow = true;
                collar.receiveShadow = true;
                columnGroup.add(collar);
            }

            if (i % 2 === 0) {
                const crackCurve = new THREE.CatmullRomCurve3([
                    new THREE.Vector3(radius * 0.58, height * 0.23, radius * 0.58),
                    new THREE.Vector3(radius * 0.7, height * 0.29, radius * 0.48),
                    new THREE.Vector3(radius * 0.57, height * 0.35, radius * 0.6),
                    new THREE.Vector3(radius * 0.72, height * 0.4, radius * 0.45)
                ]);
                const crack = new THREE.Mesh(
                    new THREE.TubeGeometry(crackCurve, 7, 0.012, 4, false),
                    materials.crack
                );
                columnGroup.add(crack);
            }

            const capital = new THREE.Mesh(
                new THREE.CylinderGeometry(radius * 1.22, radius * 1.42, 0.3, 8),
                materials.stone[(i + 1) % materials.stone.length]
            );
            capital.position.y = height + 0.34;
            capital.castShadow = true;
            capital.receiveShadow = true;
            columnGroup.add(capital);
            addBox(
                columnGroup,
                [radius * 2.75, 0.28, radius * 2.75],
                [0, height + 0.58, 0],
                materials.columnLight
            );
            addBox(
                columnGroup,
                [radius * 2.25, 0.12, radius * 2.25],
                [0, height + 0.78, 0],
                materials.metalEdge
            );
            addBox(
                columnGroup,
                [radius * 1.72, 0.14, radius * 1.72],
                [0, height + 0.91, 0],
                materials.columnLight
            );
            if (i % 3 === 1) {
                const brokenCap = addBox(
                    columnGroup,
                    [radius * 1.2, 0.26, radius * 1.4],
                    [radius * 0.24, height + 0.82, -radius * 0.12],
                    materials.stone[(i + 2) % materials.stone.length]
                );
                brokenCap.rotation.z = 0.12;
            }

        });

        createAncientLintels();
        createBrokenWallsAndSupplies();
    }

    function createAncientLintels() {
        const span = 10.8;
        const deckY = 4.72;
        const walkwayZ = -4.55;
        addBox(world, [span, 0.2, 1.05], [0, deckY, walkwayZ], materials.metal);
        addBox(world, [span + 0.3, 0.12, 0.12], [0, deckY + 0.13, walkwayZ - 0.5], materials.metalEdge);
        addBox(world, [span + 0.3, 0.12, 0.12], [0, deckY + 0.13, walkwayZ + 0.5], materials.metalEdge);

        for (let x = -4.8; x <= 4.8; x += 1.6) {
            const plank = addBox(
                world,
                [1.52, 0.045, 0.92],
                [x, deckY + 0.12, walkwayZ],
                x % 3.2 === 0 ? materials.columnLight : materials.metalEdge,
                { castShadow: false }
            );
            plank.rotation.y = x * 0.003;
        }

        for (let bay = 0; bay < 4; bay++) {
            const centerX = -3.6 + bay * 2.4;
            [-1, 1].forEach((direction) => {
                const brace = addBox(
                    world,
                    [2.7, 0.1, 0.12],
                    [centerX, deckY + 0.82, walkwayZ],
                    materials.metalEdge
                );
                brace.rotation.z = direction * 0.52;
            });
        }

        [-4.8, -3.4, 0, 3.2, 4.8].forEach((x) => {
            addBox(world, [0.14, 0.92, 0.14], [x, deckY + 0.57, walkwayZ], materials.metal);
        });
    }

    function createBrokenWallsAndSupplies() {
        const floorY = 0.08;
        const wallFragments = [
            { x: -5.25, z: 4.08, width: 0.62, height: 1.22, depth: 0.48, lean: -0.08 },
            { x: 5.38, z: 1.92, width: 0.72, height: 1.62, depth: 0.42, lean: 0.06 },
            { x: -3.75, z: -4.62, width: 1.35, height: 0.86, depth: 0.34, lean: -0.04 }
        ];
        wallFragments.forEach(({ x, z, width, height, depth, lean }, index) => {
            const wall = addBox(
                platform,
                [width, height, depth],
                [x, floorY + height / 2, z],
                materials.stone[index % materials.stone.length],
                { rotation: [0, 0, lean] }
            );
            wall.receiveShadow = true;
            const brokenCap = addBox(
                platform,
                [width * 1.12, 0.14, depth * 1.16],
                [x + width * 0.12, floorY + height + 0.02, z],
                materials.columnLight
            );
            brokenCap.rotation.z = -lean * 1.4 + (index % 2 ? 0.08 : -0.06);
        });

        const createCrate = (x, z, size, rotation) => {
            const crate = new THREE.Group();
            crate.position.set(x, floorY, z);
            crate.rotation.y = rotation;
            platform.add(crate);
            addContactShadow(crate, size * 1.5, size * 1.5, 0.008);
            const wood = makeMaterial(0x584638, 0.92, 0.02);
            const trim = makeMaterial(0x957047, 0.56, 0.4);
            addBox(crate, [size, size * 0.76, size], [0, size * 0.38, 0], wood);
            [-1, 1].forEach((side) => {
                addBox(crate, [size * 1.08, size * 0.1, size * 0.1], [0, size * 0.25, side * size * 0.46], trim);
                addBox(crate, [size * 1.08, size * 0.1, size * 0.1], [0, size * 0.68, side * size * 0.46], trim);
            });
            [-1, 1].forEach((side) => {
                addBox(crate, [size * 0.09, size * 0.76, size * 0.09], [side * size * 0.44, size * 0.38, 0], trim);
            });
        };
        createCrate(-3.9, -4.72, 0.72, 0.08);
        createCrate(1.7, -4.52, 0.62, -0.12);
        createCrate(-2.2, 4.42, 0.66, 0.16);
        createCrate(2.2, 4.34, 0.54, -0.08);

        const floorPlates = [
            [-3.5, -4.82, 0.18],
            [-1.4, 4.5, -0.12],
            [1.2, 4.48, 0.26]
        ];
        floorPlates.forEach(([x, z, rotation], index) => {
            const plate = addBox(
                platform,
                [1.12, 0.045, 0.46],
                [x, floorY + 0.01, z],
                index % 2 ? materials.metal : materials.metalEdge,
                { castShadow: false }
            );
            plate.rotation.y = rotation;
            const inset = addBox(
                platform,
                [0.82, 0.018, 0.29],
                [x, floorY + 0.041, z],
                materials.metal,
                { castShadow: false }
            );
            inset.rotation.y = rotation;
        });
    }

    function createPylon(x, z, color, scale = 1, type = "relay") {
        const group = new THREE.Group();
        group.position.set(x, 0, z);
        const parent = type === "source" ? platform : decorativeTerminalGroup ?? platform;
        const isBeacon = type === "beacon" || type === "source";
        parent.add(group);
        if (type === "source") {
            const wallEmitter = new THREE.Group();
            group.add(wallEmitter);
            addBox(wallEmitter, [0.36, 1.55, 1.42], [0, 0.78, 0], materials.stone[2]);
            addBox(wallEmitter, [0.48, 0.12, 1.56], [0, 1.52, 0], materials.metalEdge);
            addBox(wallEmitter, [0.48, 0.12, 1.56], [0, 0.08, 0], materials.metalEdge);
            addBox(wallEmitter, [0.08, 1.35, 0.1], [0, 0.8, -0.55], materials.metal);
            addBox(wallEmitter, [0.08, 1.35, 0.1], [0, 0.8, 0.55], materials.metal);

            const emitterRing = new THREE.Mesh(
                new THREE.TorusGeometry(0.31, 0.055, 8, 28),
                new THREE.MeshBasicMaterial({
                    color: 0xff70de,
                    toneMapped: false,
                    blending: THREE.AdditiveBlending
                })
            );
            emitterRing.position.set(0.2, 0.82, 0);
            wallEmitter.add(emitterRing);
            const emitterCore = new THREE.Mesh(
                new THREE.SphereGeometry(0.16, 12, 8),
                new THREE.MeshBasicMaterial({ color: 0xffd5f4, toneMapped: false })
            );
            emitterCore.position.copy(emitterRing.position);
            wallEmitter.add(emitterCore);
            const beaconLight = configureQualityLight(new THREE.PointLight(0xff45cf, 8, 3.8, 2));
            beaconLight.position.copy(emitterRing.position);
            wallEmitter.add(beaconLight);
            group.userData.wallEmitter = wallEmitter;
            group.userData.emitterRing = emitterRing;
            group.userData.emitterCore = emitterCore;
            group.userData.beaconLight = beaconLight;
            return group;
        }
        const colorMaterial = new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 0.48,
            metalness: 0.08,
            roughness: 0.24,
            flatShading: true,
            vertexColors: true
        });
        const foot = addBox(group, [0.8 * scale, 0.14, 0.67 * scale], [0, 0.12, 0], materials.metal);
        foot.rotation.y = Math.PI / 8;
        addBox(group, [0.62 * scale, 0.09, 0.48 * scale], [0, 0.23, 0], materials.metalEdge);

        const shaftHeight = (isBeacon ? 1.14 : 0.72) * scale;
        const crystal = new THREE.Mesh(
            createFacetedCrystalGeometry(0.28 * scale, shaftHeight, 6),
            colorMaterial
        );
        crystal.position.set(0, 0.3, 0);
        crystal.castShadow = true;
        group.add(crystal);

        const pointLight = configureQualityLight(new THREE.PointLight(
            color,
            isBeacon ? 7 : 3,
            isBeacon ? 3.8 : 2.4,
            2
        ));
        pointLight.position.set(0, 0.3 + shaftHeight * 0.82, 0);
        group.add(pointLight);
        if (isBeacon) group.userData.beaconLight = pointLight;
        return group;
    }

    function createTerminals() {
        decorativeTerminalGroup = new THREE.Group();
        platform.add(decorativeTerminalGroup);
        sourcePylon = createPylon(-2.55, -3.55, colors.pink, 0.8, "source");
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
            const lamp = configureQualityLight(new THREE.PointLight(color, 3.5, 4.5, 2));
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
            emissiveIntensity: 0.68,
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
                const light = configureQualityLight(new THREE.PointLight(colors.blue, 1.1, 1.8, 2));
                light.position.set(x + Math.cos(angle) * r, 0.85, z + Math.sin(angle) * r);
                platform.add(light);
            }
        }

        const hologram = new THREE.Group();
        hologram.position.set(x, CORE_HOLOGRAM_Y, z);
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
        corePulse.position.y = CORE_PULSE_Y;
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

    function setupCamera() {
        const target = new THREE.Vector3(-0.65, window.innerWidth < 620 ? -0.5 : -0.3, -0.1);
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
        const narrowFrame = canvas.clientWidth / Math.max(canvas.clientHeight, 1) < 1.25;
        cameraState.distance = window.innerWidth < 620
            ? (narrowFrame ? 18 : 19.5)
            : (narrowFrame ? 20 : 19);
        setupCamera();
    }

    function resize() {
        const width = Math.max(1, canvas.clientWidth);
        const height = Math.max(1, canvas.clientHeight);
        const mobileQuality = width < 620;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, mobileQuality ? 1.5 : 2);
        if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
        renderer.shadowMap.enabled = true;
        moonLight.castShadow = true;
        moonLight.shadow.mapSize.set(mobileQuality ? 1024 : 2048, mobileQuality ? 1024 : 2048);
        renderer.setSize(width, height, false);
        composer.setSize(width, height);
        camera.aspect = width / height;
        camera.fov = width < 620 ? 68 : 37;
        camera.updateProjectionMatrix();
        bloom.setSize(width, height);
        resetCamera();
        scheduleRender();
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
    createColumnsAndRuins();
    createCore();
    createTerminals();
    createLightNetwork();
    createSquarePlacementGrid();
    const hoverRing = createGameplaySurface();
    bindCameraControls();
    bindGameplay(hoverRing);
    resize();
    window.addEventListener("fluxgrid:load-level", (event) => {
        loadLevel(event.detail);
    });

    const clock = new THREE.Clock();
    function scheduleRender() {
        if (!document.hidden && canvas.clientWidth > 0 && canvas.clientHeight > 0 && !renderRequest) {
            renderRequest = requestAnimationFrame(render);
        }
    }
    function render() {
        renderRequest = 0;
        if (document.hidden || canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
        renderRequest = requestAnimationFrame(render);
        const time = clock.getElapsedTime();
        tutorialTargetMarker.material.opacity = 0.55 + Math.sin(time * 3.4) * 0.2;
        if (tracing && traceResult) {
            const duration = Math.max(650, traceResult.segments.length * 175);
            const progress = Math.min(1, (performance.now() - traceStartedAt) / duration);
            const visibleCount = progress >= 1
                ? traceResult.segments.length
                : Math.min(traceResult.segments.length, Math.floor(progress * traceResult.segments.length) + 1);
            beamSegments.forEach(({ halo, glow, core }, index) => {
                const visible = index < visibleCount;
                halo.visible = visible;
                glow.visible = visible;
                core.visible = visible;
            });
            traceResult.crystalHits.forEach(({ cellKey, segmentIndex }) => {
                if (segmentIndex >= visibleCount) return;
                const crystal = levelCrystals.get(cellKey);
                if (!crystal || crystal.activated) return;
                crystal.activated = true;
                const outputColor = crystalColors[crystal.definition.outputColor];
                crystal.material.emissiveIntensity = 1.65;
                crystal.material.color.setHex(outputColor);
                crystal.ringMaterial.color.setHex(outputColor);
                crystal.light.color.setHex(outputColor);
                crystal.prism.scale.setScalar(1.16);
                setFeedback(
                    `Crystal ${String(crystal.definition.index + 1).padStart(2, "0")} / ${String(activeLevel.crystals.length).padStart(2, "0")} charged. Following the beam to the battery…`,
                    "success"
                );
            });

            if (progress >= 1) {
                tracing = false;
                traceButton.disabled = false;
                traceButton.innerHTML = "<span>▶</span> TRACE AGAIN";
                if (traceResult.outcome === "powered") {
                    if (firstLevelTutorial) {
                        firstLevelTutorialStage = "complete";
                        tutorialTargetMarker.visible = false;
                        updateFirstLevelTutorial(
                            "COMPLETE",
                            "You solved the route",
                            "The crystal charged and the battery connected. Rotate a mirror to preview changes before launching in later levels."
                        );
                    }
                    setCorePowered(true);
                    if (!powerSourceSoundPlayed) {
                        powerSourceSoundPlayed = true;
                        playSoundEffect("powerSource");
                    }
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
                    pendingLevelCompletion = {
                        level: activeLevel,
                        elapsedMilliseconds,
                        result: starResult,
                        detail: {
                            number: activeLevel.number,
                            stars: starResult.stars,
                            elapsedMilliseconds,
                            walletSessionId: walletLevelSessionId,
                            gamePointsSession,
                            launchDirection,
                            mirrors: [...placedMirrors.values()].map(({ row, col, slash }) => ({ row, col, slash }))
                        }
                    };
                    window.dispatchEvent(new CustomEvent("fluxgrid:core-activation-start"));
                    setStatus("Core energizing", "The battery is powering up. Mission results will appear after the activation sequence.", "success");
                } else {
                    coreLight.intensity = 14;
                    if (sourcePylon?.userData.beaconLight) sourcePylon.userData.beaconLight.intensity = 7;
                    const ending = traceResult.outcome === "loop"
                        ? "The beam loops back on itself."
                        : traceResult.outcome === "blocked"
                            ? "The beam hits an obstacle."
                            : traceResult.outcome === "underpowered"
                                ? `The battery received the beam, but this sector requires ${activeLevel.par} mirrors on its path; only ${traceResult.reflections} reflected the beam.`
                                : traceResult.outcome === "crystal_missed"
                                    ? "The battery was reached, but not every crystal was charged."
                                    : traceResult.outcome === "crystal_mismatch"
                                        ? "A crystal rejected the beam color. Follow the crystal color sequence."
                                        : traceResult.outcome === "crystal_order_mismatch"
                                            ? "The beam reached a crystal out of sequence."
                                : "The beam misses the battery and exits the platform.";
                    setStatus("Route interrupted", `${ending} No reward is credited for a failed attempt; the entry fee remains spent. Adjust the mirrors or try again.`, "miss");
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
            const activationProgress = Math.min(
                (performance.now() - coreActivatedAt) / 950,
                1
            );
            coreActivationGroup.visible = activationProgress < 1;
            coreActivationGroup.scale.setScalar(0.82 + activationProgress * 0.45);
            activationRingMaterials.forEach((material, index) => {
                material.opacity = Math.max(0, 0.46 * (1 - activationProgress) - index * 0.035);
            });
            if (activationProgress >= 1 && pendingLevelCompletion) {
                finishLevelCompletion(pendingLevelCompletion);
            }
        } else {
            coreLight.intensity = 14;
            coreActivationGroup.visible = false;
            if (corePulse) corePulse.scale.setScalar(1 + Math.sin(time * 1.8) * 0.025);
        }
        if (renderer.shadowMap.enabled) composer.render();
        else renderer.render(scene, camera);
    }
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            cancelAnimationFrame(renderRequest);
            renderRequest = 0;
        } else {
            scheduleRender();
        }
    });
    scheduleRender();
    window.addEventListener("resize", resize);
}
