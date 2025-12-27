const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔨 Building MyHackMD...\n');

// Step 1: Install pkg if not installed
console.log('📦 Checking dependencies...');
try {
  require('pkg');
} catch (e) {
  console.log('Installing pkg...');
  execSync('npm install pkg --save-dev', { stdio: 'inherit' });
}

// Step 2: Build .exe directly in root directory
console.log('\n🔨 Building .exe file...');
try {
  execSync('npx pkg server.js --targets node18-win-x64 --output MyHackMd.exe', { stdio: 'inherit' });
  console.log('✅ Build successful! MyHackMd.exe created in root directory');
} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
}

console.log('\n✨ Build completed!');
console.log('📦 File MyHackMd.exe is ready in the root directory');
console.log('\n📝 Note:');
console.log('   - The .exe will automatically create bin/ folder when running');
console.log('   - The public/ folder is bundled inside the .exe');
console.log('   - Just run MyHackMd.exe to start the server!');

