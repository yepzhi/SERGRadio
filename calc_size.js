import pathToFfmpeg from 'ffmpeg-static';
import { exec } from 'child_process';
import { readdir } from 'fs/promises';
import { join } from 'path';

const INPUT_DIR = 'public/tracks';

async function calculate() {
    const files = await readdir(INPUT_DIR);
    let totalSeconds = 0;

    const promises = files.filter(f => f.endsWith('.mp3')).map(file => {
        return new Promise((resolve) => {
            const cmd = `"${pathToFfmpeg}" -i "${join(INPUT_DIR, file)}" 2>&1 | grep "Duration"`;
            exec(cmd, (err, stdout) => {
                // Output: Duration: 01:23:45.67, ...
                const match = stdout.match(/Duration: (\d{2}):(\d{2}):(\d{2})/);
                if (match) {
                    const h = parseInt(match[1]);
                    const m = parseInt(match[2]);
                    const s = parseInt(match[3]);
                    const seconds = (h * 3600) + (m * 60) + s;
                    totalSeconds += seconds;
                }
                resolve();
            });
        });
    });

    await Promise.all(promises);

    console.log(`Total Duration: ${totalSeconds} seconds`);
    console.log(`Total Hours: ${(totalSeconds / 3600).toFixed(2)} hours`);

    // Calculate Sizes (Bitrate * Seconds / 8 / 1024 / 1024 = MB)
    const calc = (kbps) => (kbps * totalSeconds / 8 / 1024).toFixed(0);

    console.log(`--- ESTIMATES ---`);
    console.log(`192kbps (MP3/AAC): ~${calc(192)} MB (Limit 1000 MB)`);
    console.log(`160kbps (MP3/AAC): ~${calc(160)} MB`);
    console.log(`128kbps (MP3/AAC): ~${calc(128)} MB`);
    console.log(`96kbps  (MP3/AAC): ~${calc(96)} MB`);
}

calculate();
