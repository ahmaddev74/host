const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const multer = require('multer');
const nodemailer = require('nodemailer'); // زیادکردنی نۆدمايلەر

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'uploads/' });

const APPS_DIR = path.join(__dirname, 'user_apps');
if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

let runningApps = {};
let registeredUsers = {};
let pendingCodes = {};
let nextPort = 4001;

// ڕێکخستنی ناردنی ئیمەیڵ بە ڕێگەی Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'YOUR_EMAIL@gmail.com', // لێرە گەیملی خۆت بنووسە
    pass: 'YOUR_APP_PASSWORD' // لێرە App Passwordـی گەیملەکەت بنووسە
  }
});

// ١. داواکردنی ناردنی کۆدی پشتڕاستکردنەوە ڕاستەوخۆ بۆ ئینبۆکسی گەیمل
app.post('/api/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.endsWith('@gmail.com')) {
    return res.status(400).json({ success: false, error: 'گەیملێکی دروست بنووسە' });
  }
  
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  pendingCodes[email] = verificationCode;
  
  const mailOptions = {
    from: 'YOUR_EMAIL@gmail.com',
    to: email,
    subject: 'کۆدی پشتڕاستکردنەوە بۆ پلاتفۆرمی هۆستینگ',
    text: `سڵاو! کۆدی پشتڕاستکردنەوەی هەژمارەکەت بریتییە لە: ${verificationCode}`
  };
  
  try {
    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: 'کۆدی پشتڕاستکردنەوە بە سەرکەوتوویی نێردرا بۆ ئینبۆکسی گەیملت!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'هەڵە لە ناردنی ئیمەیڵ. دڵنیابە لە ڕاستی زانیارییەکانی گەیملەکەت.' });
  }
});

app.post('/api/auth/verify-and-login', (req, res) => {
  const { email, code, password } = req.body;
  if (!email || !code) {
    return res.status(400).json({ success: false, error: 'گەیمل و کۆد پێویستن' });
  }
  
  if (pendingCodes[email] !== code) {
    return res.status(400).json({ success: false, error: 'کۆدی پشتڕاستکردنەوە هەڵەیە!' });
  }
  
  if (registeredUsers[email]) {
    if (password && registeredUsers[email].password && registeredUsers[email].password !== password) {
      return res.status(400).json({ success: false, error: 'پاسوۆردی ئەم گەیملە هەڵەیە!' });
    }
  } else {
    registeredUsers[email] = {
      userId: 'user_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
      email: email,
      password: password || ''
    };
  }
  
  delete pendingCodes[email];
  res.json({ success: true, userId: registeredUsers[email].userId, email: email });
});

app.get('/api/stats', (req, res) => {
  const now = new Date();
  const userId = req.query.userId;
  const appsInfo = {};
  let userAppsCount = 0;
  
  for (const [name, data] of Object.entries(runningApps)) {
    if (now > new Date(data.expiresAt)) {
      if (data.process) data.process.kill();
      delete runningApps[name];
      continue;
    }
    
    if (!userId || data.userId === userId) {
      appsInfo[name] = {
        port: data.port,
        logs: data.logs || [],
        expiresAt: data.expiresAt
      };
      userAppsCount++;
    }
  }
  
  res.json({
    totalApps: userAppsCount,
    apps: appsInfo
  });
});

app.use('/app/:appName', (req, res, next) => {
  const appName = req.params.appName;
  const appData = runningApps[appName];
  if (!appData) return res.status(404).send('پڕۆژە نەدۆزرایەوە یان بەسەرچووە!');
  
  createProxyMiddleware({
    target: `http://localhost:${appData.port}`,
    changeOrigin: true,
    pathRewrite: {
      [`^/app/${appName}`]: '' },
    ws: true
  })(req, res, next);
});

app.post('/deploy-file', upload.single('projectFile'), (req, res) => {
  const { appName, userId } = req.body;
  const file = req.file;
  
  if (!appName || !file || !userId) {
    return res.status(400).json({ error: 'ناوی پڕۆژە، فایل و ناسنامەی بەکارهێنەر پێویستن' });
  }
  
  const safeAppName = appName.replace(/[^a-zA-Z0-9_-]/g, '');
  const appDir = path.join(APPS_DIR, safeAppName);
  if (!fs.existsSync(appDir)) {
    fs.mkdirSync(appDir, { recursive: true });
  }
  
  const fileExt = path.extname(file.originalname).toLowerCase();
  let targetScript = path.join(appDir, 'index.js');
  
  if (fileExt === '.py') {
    targetScript = path.join(appDir, 'main.py');
  }
  
  fs.renameSync(file.path, targetScript);
  
  const port = nextPort++;
  
  if (runningApps[safeAppName]?.process) {
    runningApps[safeAppName].process.kill();
  }
  
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  
  runningApps[safeAppName] = {
    port: port,
    process: null,
    logs: [],
    expiresAt: expiresAt,
    userId: userId
  };
  
  let runCommand = 'node';
  let runArgs = [targetScript];
  
  if (fileExt === '.py') {
    runCommand = 'python';
    runArgs = [targetScript];
  }
  
  const childProcess = spawn(runCommand, runArgs, {
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  runningApps[safeAppName].process = childProcess;
  
  childProcess.stdout.on('data', (data) => {
    const logMsg = `[LOG]: ${data.toString().trim()}`;
    runningApps[safeAppName].logs.push(logMsg);
    if (runningApps[safeAppName].logs.length > 50) runningApps[safeAppName].logs.shift();
  });
  
  childProcess.stderr.on('data', (data) => {
    const errorMsg = `[ERROR]: ${data.toString().trim()}`;
    runningApps[safeAppName].logs.push(errorMsg);
  });
  
  childProcess.on('exit', (code) => {
    const exitMsg = `[SYSTEM]: پڕۆژەکە وەستا بە کۆدی ${code}`;
    runningApps[safeAppName]?.logs.push(exitMsg);
  });
  
  res.json({ success: true, message: 'پڕۆژەکە بە سەرکەوتوویی بۆ ماوەی مانگێک هۆست کرا!', url: `/app/${safeAppName}` });
});

app.post('/deploy-github', async (req, res) => {
  const { repoUrl, appName, userId } = req.body;
  
  if (!repoUrl || !appName || !userId) {
    return res.status(400).json({ error: 'لینک، ناوی پڕۆژە و ناسنامەی بەکارهێنەر پێویستن' });
  }
  
  const safeAppName = appName.replace(/[^a-zA-Z0-9_-]/g, '');
  const appDir = path.join(APPS_DIR, safeAppName);
  
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
  
  try {
    execSync(`git clone ${repoUrl} ${appDir}`);
    
    let runCommand = 'node';
    let targetScript = 'index.js';
    
    if (fs.existsSync(path.join(appDir, 'package.json'))) {
      execSync('npm install', { cwd: appDir });
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      if (pkg.main && fs.existsSync(path.join(appDir, pkg.main))) {
        targetScript = pkg.main;
      }
    } else if (fs.existsSync(path.join(appDir, 'requirements.txt'))) {
      runCommand = 'python';
      targetScript = 'main.py';
      execSync('pip install -r requirements.txt', { cwd: appDir });
    } else if (fs.existsSync(path.join(appDir, 'main.py'))) {
      runCommand = 'python';
      targetScript = 'main.py';
    }
    
    const port = nextPort++;
    if (runningApps[safeAppName]?.process) {
      runningApps[safeAppName].process.kill();
    }
    
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    
    runningApps[safeAppName] = {
      port: port,
      process: null,
      logs: [],
      expiresAt: expiresAt,
      userId: userId
    };
    
    const targetScriptPath = path.join(appDir, targetScript);
    const childProcess = spawn(runCommand, [targetScriptPath], {
      cwd: appDir,
      env: { ...process.env, PORT: port },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    runningApps[safeAppName].process = childProcess;
    
    childProcess.stdout.on('data', (data) => {
      runningApps[safeAppName].logs.push(`[LOG]: ${data.toString().trim()}`);
      if (runningApps[safeAppName].logs.length > 50) runningApps[safeAppName].logs.shift();
    });
    
    childProcess.stderr.on('data', (data) => {
      runningApps[safeAppName].logs.push(`[ERROR]: ${data.toString().trim()}`);
    });
    
    res.json({ success: true, message: 'پڕۆژەی گیتهاب بە سەرکەوتوویی ئینستال و هۆست کرا!', url: `/app/${safeAppName}` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'هەڵە لە هینانی پڕۆژەی گیتهاب: ' + err.message });
  }
});

app.delete('/api/apps/:appName', (req, res) => {
  const appName = req.params.appName;
  if (runningApps[appName]) {
    if (runningApps[appName].process) {
      runningApps[appName].process.kill();
    }
    delete runningApps[appName];
    res.json({ success: true, message: 'پڕۆژە سڕایەوە' });
  } else {
    res.status(404).json({ error: 'نەدۆزرایەوە' });
  }
});

app.listen(PORT, () => console.log(`سێرڤەر لەسەر پۆرت ${PORT} کار دەکات`));