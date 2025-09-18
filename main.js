const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// 主窗口
let mainWindow = null;
// 遮罩窗口
let overlayWindow = null;
// 选区窗口
let selectionOverlayWindow = null;
// 系统托盘
let tray = null;
// 当前选区
let currentSelection = null;
// FFmpeg 进程
let ffmpegProcess = null;
// 录制状态
let isRecording = false;
// 选区状态
let hasSelection = false;

// 获取 FFmpeg 可执行文件路径
function getFFmpegPath() {
  let ffmpegPath;
  if (app.isPackaged) {
    // 打包后的路径 - 检查 asar.unpacked 目录
    ffmpegPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'ff', 'ffmpeg.exe');
    console.log('Packaged app, checking FFmpeg at:', ffmpegPath);
  } else {
    // 开发环境路径
    ffmpegPath = path.join(__dirname, 'ff', 'ffmpeg.exe');
    console.log('Dev environment, FFmpeg at:', ffmpegPath);
  }
  
  // 如果在打包应用中找不到，尝试其他可能的路径
  if (app.isPackaged && !fs.existsSync(ffmpegPath)) {
    console.log('FFmpeg not found at primary path, trying alternative paths...');
    // 尝试直接在 resources 目录下查找
    const altPath1 = path.join(process.resourcesPath, 'ff', 'ffmpeg.exe');
    if (fs.existsSync(altPath1)) {
      ffmpegPath = altPath1;
      console.log('Found FFmpeg at alternative path 1:', ffmpegPath);
    } else {
      // 尝试在应用根目录查找
      const altPath2 = path.join(app.getAppPath(), '..', 'ff', 'ffmpeg.exe');
      if (fs.existsSync(altPath2)) {
        ffmpegPath = altPath2;
        console.log('Found FFmpeg at alternative path 2:', ffmpegPath);
      } else {
        console.log('FFmpeg not found at any alternative paths');
      }
    }
  }
  
  return ffmpegPath;
}

const ffmpegPath = getFFmpegPath();
console.log('Final FFmpeg path:', ffmpegPath);

// 创建系统托盘
function createTray() {
  try {
    // 创建系统托盘图标（使用你提供的图标文件）
    tray = new Tray(path.join(__dirname, 'icon.png'));
    
    // 设置初始提示文本
    tray.setToolTip('屏幕录制工具 - 点击选择录制区域');
    
    // 创建上下文菜单
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '选择录制区域',
        click: () => {
          handleF2Press();
        }
      },
      {
        label: '取消选择',
        enabled: false, // 初始状态不能取消选择
        click: () => {
          cancelSelection();
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit();
        }
      }
    ]);
    
    // 设置上下文菜单
    tray.setContextMenu(contextMenu);
    
    // 设置托盘图标点击事件
    tray.on('click', () => {
      handleF2Press();
    });
  } catch (error) {
    console.error('创建系统托盘失败:', error);
  }
}

// 处理F2按键逻辑
function handleF2Press() {
  // 第一次按下F2：显示遮罩层并进入区域划选模式
  if (!hasSelection && !isRecording) {
    createOverlayWindow();
  }
  // 第二次按下F2：开始录制当前选区
  else if (hasSelection && !isRecording) {
    startRecording();
  }
  // 第三次按下F2：结束录制
  else if (isRecording) {
    stopRecording();
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

function createOverlayWindow() {
  // 如果已有遮罩窗口，先关闭
  if (overlayWindow) {
    overlayWindow.close();
  }
  
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  overlayWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: width,
    height: height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.loadFile('overlay.html');
  overlayWindow.setBackgroundColor('#00000000');
  
  // 确保只注册一次事件监听器
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.executeJavaScript(`
      document.body.addEventListener('mouseup', (e) => {
        if (e.button === 0) { // 左键
          const selection = window.getSelectionRect();
          if (selection.width > 10 && selection.height > 10) {
            require('electron').ipcRenderer.send('selection-complete', selection);
          }
        }
      });
    `);
  });
}

function createSelectionOverlayWindow(bounds, showHint = true, recording = false) {
  // 如果已有选区窗口，先关闭
  if (selectionOverlayWindow) {
    selectionOverlayWindow.close();
  }
  
  // 创建一个只覆盖选区区域的小窗口
  const padding = 10;
  const windowWidth = bounds.width + padding * 2;
  const windowHeight = bounds.height + padding * 2;
  
  selectionOverlayWindow = new BrowserWindow({
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: windowWidth,
    height: windowHeight,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // 设置窗口为不可点击穿透
  selectionOverlayWindow.setIgnoreMouseEvents(true);
  
  // 根据是否是录制状态设置不同的边框样式
  const borderWidth = '1px';
  const borderStyle = 'dashed';
  const borderColor = '#00ff00';
  
  // 创建包含边框和提示文字的HTML
  const overlayHTML = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            * {
                pointer-events: none !important;
                user-select: none !important;
            }
            body {
                margin: 0;
                padding: 0;
                background-color: transparent;
                overflow: hidden;
                pointer-events: none !important;
                font-family: Arial, sans-serif;
            }
            .selection-border {
                position: absolute;
                left: ${padding}px;
                top: ${padding}px;
                width: ${bounds.width}px;
                height: ${bounds.height}px;
                border: ${borderWidth} ${borderStyle} ${borderColor};
                box-sizing: border-box;
                background-color: transparent;
                pointer-events: none !important;
            }
            .hint-text {
                position: absolute;
                left: ${padding + bounds.width/2}px;
                top: ${padding + bounds.height/2}px;
                transform: translate(-50%, -50%);
                color: #888888;
                font-size: 16px;
                font-weight: bold;
                text-align: center;
                background-color: rgba(255, 255, 255, 0.8);
                padding: 8px 16px;
                border-radius: 4px;
                pointer-events: none !important;
                display: ${showHint ? 'block' : 'none'};
            }
        </style>
    </head>
    <body>
        <div class="selection-border"></div>
        <div class="hint-text">${recording ? '正在录制...' : '按 F2 开始录屏'}</div>
    </body>
    </html>
  `;
  
  // 设置窗口内容
  selectionOverlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHTML)}`);
  selectionOverlayWindow.setBackgroundColor('#00000000');
  
  // 加载完成后显示窗口
  selectionOverlayWindow.webContents.once('did-finish-load', () => {
    selectionOverlayWindow.show();
  });
}

app.whenReady().then(() => {
  // 创建系统托盘
  createTray();
  
  // 尝试注册F2快捷键，如果失败则使用Ctrl+F2
  let isRegistered = false;
  
  if (globalShortcut.register('F2', () => {
    console.log('F2 key pressed');
    handleF2Press();
  })) {
    console.log('F2 shortcut registered successfully');
    isRegistered = true;
  } else {
    console.log('F2 shortcut registration failed, trying Ctrl+F2');
    if (globalShortcut.register('Ctrl+F2', () => {
      console.log('Ctrl+F2 key pressed (acting as F2)');
      handleF2Press();
    })) {
      console.log('Ctrl+F2 shortcut registered successfully (acting as F2)');
      isRegistered = true;
    } else {
      console.log('Ctrl+F2 shortcut registration also failed');
    }
  }

  app.on('activate', () => {
    // 不再创建主窗口
  });
});

app.on('window-all-closed', () => {
  // 不再退出应用
});

app.on('will-quit', () => {
  // 注销所有快捷键
  globalShortcut.unregisterAll();
  
  // 确保 FFmpeg 进程被终止
  if (ffmpegProcess) {
    ffmpegProcess.kill();
  }
});

// IPC 处理程序
ipcMain.on('start-overlay', () => {
  createOverlayWindow();
});

ipcMain.on('selection-complete', (event, bounds) => {
  currentSelection = bounds;
  hasSelection = true;
  
  // 关闭遮罩窗口
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
  
  // 创建选区窗口，显示虚线边框（框选状态）
  createSelectionOverlayWindow(bounds, true, false);
  
  // 更新托盘菜单
  updateTrayMenu();
});

// 添加取消选择的IPC处理程序
ipcMain.on('cancel-selection', () => {
  cancelSelection();
});

function startRecording() {
  if (!currentSelection) {
    return;
  }
  
  isRecording = true;
  
  try {
    // 创建临时文件路径
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `temp-recording-${Date.now()}.mp4`);
    
    // 重新创建选区窗口，只显示边框，不显示提示，并设置为录制状态
    createSelectionOverlayWindow(currentSelection, false, true);
    
    // 确保选区窗口不会拦截鼠标事件
    if (selectionOverlayWindow) {
      selectionOverlayWindow.setIgnoreMouseEvents(true);
    }
    
    // 开始录制到临时文件
    startFFmpegRecording(currentSelection, tempFilePath);
  } catch (error) {
    console.error('开始录制失败:', error);
  }
  
  // 更新托盘菜单
  updateTrayMenu();
}

function stopRecording() {
  // 停止录制
  stopFFmpegRecording();
  isRecording = false;
  hasSelection = false;
  
  // 关闭选区窗口
  if (selectionOverlayWindow) {
    selectionOverlayWindow.close();
    selectionOverlayWindow = null;
  }
  
  // 更新托盘菜单
  updateTrayMenu();
}

function cancelSelection() {
  console.log('Cancel selection called'); // 添加调试信息
  currentSelection = null;
  hasSelection = false;
  isRecording = false;
  
  // 关闭选区窗口
  if (selectionOverlayWindow) {
    selectionOverlayWindow.close();
    selectionOverlayWindow = null;
  }
  
  // 关闭遮罩窗口
  if (overlayWindow) {
    overlayWindow.close();
    overlayWindow = null;
  }
  
  // 更新托盘菜单
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  
  // 根据当前状态更新托盘图标提示文本
  let tooltipText = '屏幕录制工具';
  if (!hasSelection && !isRecording) {
    tooltipText = '屏幕录制工具 - 点击选择录制区域';
  } else if (hasSelection && !isRecording) {
    tooltipText = '屏幕录制工具 - 点击开始录制';
  } else if (isRecording) {
    tooltipText = '屏幕录制工具 - 正在录制中... 点击停止录制';
  }
  
  tray.setToolTip(tooltipText);
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: hasSelection && !isRecording ? '开始录制' : isRecording ? '停止录制' : '选择录制区域',
      click: () => {
        handleF2Press();
      }
    },
    {
      label: '取消选择',
      enabled: hasSelection && !isRecording, // 录制时不能取消选区
      click: () => {
        cancelSelection();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
}

function startFFmpegRecording(bounds, outputPath) {
  try {
    console.log('Starting FFmpeg recording...'); // 调试信息
    console.log('FFmpeg path:', ffmpegPath); // 调试信息
    
    // 检查 FFmpeg 是否存在
    if (!fs.existsSync(ffmpegPath)) {
      const errorMsg = `FFmpeg 未找到，请确保 ffmpeg.exe 存在于 ${ffmpegPath} 目录中`;
      console.error(errorMsg);
      dialog.showErrorBox('FFmpeg 错误', errorMsg);
      throw new Error(errorMsg);
    }
    
    console.log('FFmpeg found, starting recording...'); // 调试信息
    
    // 为了避免录制到虚线框，我们需要稍微缩小捕获区域
    // 从每边减少2像素，以避免捕获到边框
    const borderOffset = 2;
    const width = (bounds.width - borderOffset * 2) % 2 === 0 ? 
                  bounds.width - borderOffset * 2 : 
                  bounds.width - borderOffset * 2 + 1;
    const height = (bounds.height - borderOffset * 2) % 2 === 0 ? 
                   bounds.height - borderOffset * 2 : 
                   bounds.height - borderOffset * 2 + 1;
    const x = bounds.x + borderOffset;
    const y = bounds.y + borderOffset;
    
    // 构建 FFmpeg 命令
    // 使用 Windows 的 gdigrab 设备来捕获屏幕
    const args = [
      '-f', 'gdigrab',
      '-framerate', '30',
      '-offset_x', x.toString(),
      '-offset_y', y.toString(),
      '-video_size', `${width}x${height}`,
      '-i', 'desktop',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-tune', 'zerolatency',
      outputPath
    ];
    
    console.log('FFmpeg command:', ffmpegPath, args.join(' '));
    
    // 启动 FFmpeg 进程
    ffmpegProcess = spawn(ffmpegPath, args);
    
    ffmpegProcess.stdout.on('data', (data) => {
      console.log(`FFmpeg stdout: ${data}`);
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
      console.log(`FFmpeg stderr: ${data}`);
    });
    
    ffmpegProcess.on('close', async (code) => {
      console.log(`FFmpeg process exited with code: ${code}`);
      ffmpegProcess = null;
      
      // 关闭选区窗口
      if (selectionOverlayWindow) {
        selectionOverlayWindow.close();
        selectionOverlayWindow = null;
      }
      
      // 录制成功，弹出保存对话框
      if (code === 0) {
        try {
          // 创建一个临时的不可见窗口用于显示保存对话框
          const tempWindow = new BrowserWindow({
            width: 0,
            height: 0,
            show: false,
            webPreferences: {
              nodeIntegration: true,
              contextIsolation: false
            }
          });
          
          const { canceled, filePath } = await dialog.showSaveDialog(tempWindow, {
            title: '保存录制视频',
            defaultPath: path.join(os.homedir(), 'Downloads', `recording-${Date.now()}.mp4`),
            filters: [
              { name: 'MP4 Video', extensions: ['mp4'] },
              { name: 'All Files', extensions: ['*'] }
            ]
          });
          
          // 关闭临时窗口
          tempWindow.close();
          
          if (canceled || !filePath) {
            // 用户取消保存，删除临时文件
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
            console.log('用户取消保存');
          } else {
            // 用户选择保存位置，移动临时文件到目标位置
            fs.renameSync(outputPath, filePath);
            console.log('文件已保存到:', filePath);
          }
        } catch (error) {
          console.error('保存文件失败:', error);
        }
      } else {
        console.log('录制失败，FFmpeg 退出码:', code);
        dialog.showErrorBox('录制失败', `FFmpeg 录制失败，退出码: ${code}`);
      }
      
      // 重置状态
      isRecording = false;
      hasSelection = false;
      updateTrayMenu();
    });
    
    ffmpegProcess.on('error', (error) => {
      console.error('FFmpeg process error:', error);
      ffmpegProcess = null;
      
      // 关闭选区窗口
      if (selectionOverlayWindow) {
        selectionOverlayWindow.close();
        selectionOverlayWindow = null;
      }
      
      console.log('FFmpeg process error:', error.message);
      dialog.showErrorBox('FFmpeg 错误', `启动 FFmpeg 失败: ${error.message}`);
      
      // 重置状态
      isRecording = false;
      hasSelection = false;
      updateTrayMenu();
    });
  } catch (error) {
    console.error('启动 FFmpeg 录制失败:', error);
    
    // 关闭录制遮罩窗口
    if (selectionOverlayWindow) {
      selectionOverlayWindow.close();
      selectionOverlayWindow = null;
    }
    
    console.log('启动 FFmpeg 录制失败:', error.message);
    dialog.showErrorBox('FFmpeg 错误', `启动 FFmpeg 录制失败: ${error.message}`);
    
    // 重置状态
    isRecording = false;
    hasSelection = false;
    updateTrayMenu();
  }
}

function stopFFmpegRecording() {
  if (ffmpegProcess) {
    // 发送 q 键盘输入来停止 FFmpeg
    ffmpegProcess.stdin.write('q');
    ffmpegProcess.stdin.end();
  }
  // 注意：不再发送 recording-stopped 事件，因为保存逻辑在FFmpeg进程关闭时处理
}

ipcMain.handle('get-screen-size', () => {
  return screen.getPrimaryDisplay().workAreaSize;
});