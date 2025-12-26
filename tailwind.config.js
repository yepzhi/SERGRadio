/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            animation: {
                'pulse-slow': 'pulse 8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'music-bar': 'music-bar 0.8s ease-in-out infinite',
                'progress-indeterminate': 'progress 2s linear infinite',
            },
        },
    },
    plugins: [],
}
