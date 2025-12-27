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

// Step 2: Build .exe in public folder
console.log('\n🔨 Building .exe file...');
console.log('⚠️  Note: Warning about socket.io is normal - it will be bundled correctly\n');
try {
  // Use package.json configuration for pkg (includes all dependencies)
  const publicDir = path.join(process.cwd(), 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }
  execSync('npx pkg . --targets node18-win-x64 --output public/MyHackMd.exe', { stdio: 'inherit' });
  console.log('\n✅ Build successful! MyHackMd.exe created in public folder');
} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
}

// Step 3: Create shortcut in root directory
console.log('\n🔗 Creating shortcut...');
try {
  const exePath = path.resolve(process.cwd(), 'public', 'MyHackMd.exe');
  const shortcutPath = path.resolve(process.cwd(), 'MyHackMD.lnk');
  const iconPath = path.resolve(process.cwd(), 'logo.ico');
  
  const shortcutScript = `
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("${shortcutPath}")
$Shortcut.TargetPath = "${exePath}"
$Shortcut.WorkingDirectory = "${process.cwd()}"
$Shortcut.IconLocation = "${iconPath}"
$Shortcut.Save()
`;
  
  // Write temporary PowerShell script
  const tempScript = path.join(process.cwd(), 'create-shortcut.ps1');
  fs.writeFileSync(tempScript, shortcutScript);
  
  // Execute PowerShell script
  execSync(`powershell -ExecutionPolicy Bypass -File "${tempScript}"`, { stdio: 'inherit' });
  
  // Clean up temporary script
  fs.unlinkSync(tempScript);
  
  console.log('✅ Shortcut "MyHackMD.lnk" created successfully in root directory!');
} catch (error) {
  console.warn('⚠️  Warning: Could not create shortcut:', error.message);
  console.log('   You can create it manually if needed');
}

console.log('\n✨ Build completed!');
console.log('📦 File MyHackMd.exe is ready in public/ folder');
console.log('🔗 Shortcut MyHackMD.lnk is ready in root directory');
console.log('\n📝 Note:');
console.log('   - The .exe will automatically create bin/ folder when running');
console.log('   - The public/ folder is bundled inside the .exe');
console.log('   - Socket.IO realtime sync is included');
console.log('   - Just double-click MyHackMD.lnk to start the server!');
console.log('\n⚠️  Important:');
console.log('   - The .exe is located in public/ folder');
console.log('   - The shortcut in root directory will launch the application');

