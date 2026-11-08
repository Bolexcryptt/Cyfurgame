import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const packagedAssets = [
    "assets",
    "companyintro.mp4",
    "gamevideo.mp4",
    "intro.mp4",
    "levels1.mp4",
    "levels2.mp4",
    "mirror.mp3",
    "music.mp3",
    "powersource.mp3",
    "theend.mp4",
    "vendor/tweetnacl.min.js"
];

export default defineConfig({
    publicDir: false,
    build: {
        outDir: "dist",
        emptyOutDir: true,
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes("/node_modules/@solana/")) return "solana";
                    if (id.includes("/node_modules/@supabase/")) return "supabase";
                    if (id.includes("/node_modules/three/")) return "three";
                    if (id.includes("/node_modules/@capacitor/")) return "capacitor";
                }
            }
        }
    },
    plugins: [{
        name: "copy-relicgrid-runtime-assets",
        closeBundle() {
            const output = resolve("dist");
            mkdirSync(output, { recursive: true });
            for (const asset of packagedAssets) {
                cpSync(resolve(asset), resolve(output, asset), { recursive: true });
            }
        }
    }]
});
