import pathToFfmpeg from 'ffmpeg-static';
import { exec } from 'child_process';
import { readdir, stat, mkdir } from 'fs/promises';
import { join, basename } from 'path';

const INPUT_DIR = 'public/tracks';
const OUTPUT_DIR = 'public/tracks_compressed';
const BITRATE = '160k';

async function compress() {
    await mkdir(OUTPUT_DIR, { recursive: true });
    const files = await readdir(INPUT_DIR);

    for (const file of files) {
        if (!file.endsWith('.mp3')) continue;

        const inputPath = join(INPUT_DIR, file);
        const outputPath = join(OUTPUT_DIR, file);

        // Check if output exists and is reasonable size (simple skip)
        // Actually, always overwrite to ensure bitrate is correct.

        console.log(`Compressing ${file} to ${BITRATE}...`);

        await new Promise((resolve, reject) => {
            // -map 0:a:0 ensures only first audio stream is copied (strips artwork if needed to save space)
            // -id3v2_version 3 for compatibility
            const cmd = `"${pathToFfmpeg}" -y -i "${inputPath}" -map 0:a:0 -b:a ${BITRATE} "${outputPath}"`;

            exec(cmd, (err, stdout, stderr) => {
                if (err) {
                    console.error(`Error processing ${file}:`, stderr);
                    reject(err);
                } else {
                    console.log(`Done: ${file}`);
                    resolve();
                }
            });
        });
    }
    console.log('All files compressed!');
}

compress().catch(console.error);
