/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Manrope Variable"', 'Manrope', 'system-ui', 'sans-serif'] },
      colors: {
        ink: { 950: '#0f0d0b', 900: '#1a1714', 800: '#26221e', 700: '#3a3530', 600: '#57504a', 500: '#7a726a', 400: '#a39b92', 300: '#cbc4bc', 200: '#e6e1db', 100: '#f3f0ec', 50: '#faf8f5' },
        brand: { 50: '#fdf5ee', 100: '#fae6d4', 200: '#f4c9a5', 300: '#eca46e', 400: '#e48343', 500: '#d96a27', 600: '#bf531d', 700: '#9d401b', 800: '#7f351d', 900: '#682e1b' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(26,23,20,.04), 0 4px 16px -4px rgba(26,23,20,.06)',
        lift: '0 2px 4px rgba(26,23,20,.05), 0 12px 32px -8px rgba(26,23,20,.14)',
      },
      keyframes: {
        'pulse-ring': { '0%': { boxShadow: '0 0 0 0 rgba(132,204,22,.55)' }, '100%': { boxShadow: '0 0 0 14px rgba(132,204,22,0)' } },
        'slide-in': { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'none' } },
        flash: { '0%,100%': { backgroundColor: 'transparent' }, '50%': { backgroundColor: 'rgba(217,106,39,.25)' } },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.6s ease-out infinite',
        'slide-in': 'slide-in .25s ease-out both',
        flash: 'flash 1s ease-in-out 3',
      },
    },
  },
  plugins: [],
};
