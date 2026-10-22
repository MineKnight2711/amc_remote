const fs = require('fs');
const path = require('path');

const srcRenderer = path.join(__dirname, '..', 'src', 'renderer');
const distRenderer = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(distRenderer, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  const srcFile = path.join(srcRenderer, file);
  const destFile = path.join(distRenderer, file);
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, destFile);
  }
}

console.log('Static assets copied to dist/renderer.');
