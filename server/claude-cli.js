import { spawn } from 'child_process';
import crossSpawn from 'cross-spawn';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { NodeSSH } from 'node-ssh';

// Use cross-spawn on Windows for better command execution
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

// Track active sessions (local or remote) by session ID
// Map<sessionId, { type: 'local', process: ChildProcess } | { type: 'ssh', ssh: NodeSSH, channel: any }>
let activeClaudeProcesses = new Map();

async function spawnClaude(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, permissionMode, images, ssh: sshConfig } = options;
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    
    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false
    };
    
    // Build Claude CLI command - start with print/resume flags first
    const args = [];
    
    // Add print flag with command if we have a command
    if (command && command.trim()) {

      // Separate arguments for better cross-platform compatibility
      // This prevents issues with spaces and quotes on Windows
      args.push('--print');
      args.push(command);
    }
    
    // Use cwd (actual project directory) instead of projectPath (Claude's metadata directory)
    const workingDir = cwd || process.cwd();
    
    // Handle images by saving them to temporary files and passing paths to Claude
    const tempImagePaths = []; // paths used in command (local or remote)
    let tempDir = null; // local temp dir
    let remoteTempDir = null; // remote temp dir when using ssh
    const localImagePaths = []; // used for uploading when using ssh
    if (images && images.length > 0) {
      try {
        const timestamp = Date.now().toString();
        if (sshConfig) {
          // When using SSH, create temp dir locally then upload to remote cwd
          tempDir = path.join(os.tmpdir(), 'claude-ssh', timestamp);
          remoteTempDir = path.posix.join(workingDir.replace(/\\/g, '/'), '.tmp', 'images', timestamp);
        } else {
          // Create temp directory in the project directory so Claude can access it
          tempDir = path.join(workingDir, '.tmp', 'images', timestamp);
        }
        await fs.mkdir(tempDir, { recursive: true });

        // Save each image to a temp file
        for (const [index, image] of images.entries()) {
          const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) {
            console.error('Invalid image data format');
            continue;
          }

          const [, mimeType, base64Data] = matches;
          const extension = mimeType.split('/')[1] || 'png';
          const filename = `image_${index}.${extension}`;
          const localPath = path.join(tempDir, filename);
          await fs.writeFile(localPath, Buffer.from(base64Data, 'base64'));

          if (sshConfig) {
            const remotePath = path.posix.join(remoteTempDir, filename);
            localImagePaths.push({ local: localPath, remote: remotePath });
            tempImagePaths.push(remotePath);
          } else {
            tempImagePaths.push(localPath);
          }
        }

        if (tempImagePaths.length > 0 && command && command.trim()) {
          const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
          const modifiedCommand = command + imageNote;

          // Update the command in args - now that --print and command are separate
          const printIndex = args.indexOf('--print');
          if (printIndex !== -1 && printIndex + 1 < args.length && args[printIndex + 1] === command) {
            args[printIndex + 1] = modifiedCommand;
          }
        }

      } catch (error) {
        console.error('Error processing images for Claude:', error);
      }
    }
    
    // Add resume flag if resuming
    if (resume && sessionId) {
      args.push('--resume', sessionId);
    }
    
    // Add basic flags
    args.push('--output-format', 'stream-json', '--verbose');
    
    // Add MCP config flag only if MCP servers are configured
    try {
      console.log('🔍 Starting MCP config check...');
      // Use already imported modules (fs.promises is imported as fs, path, os)
      const fsSync = await import('fs'); // Import synchronous fs methods
      console.log('✅ Successfully imported fs sync methods');
      
      // Check for MCP config in ~/.claude.json
      const claudeConfigPath = path.join(os.homedir(), '.claude.json');
      
      console.log(`🔍 Checking for MCP configs in: ${claudeConfigPath}`);
      console.log(`  Claude config exists: ${fsSync.existsSync(claudeConfigPath)}`);
      
      let hasMcpServers = false;
      
      // Check Claude config for MCP servers
      if (fsSync.existsSync(claudeConfigPath)) {
        try {
          const claudeConfig = JSON.parse(fsSync.readFileSync(claudeConfigPath, 'utf8'));
          
          // Check global MCP servers
          if (claudeConfig.mcpServers && Object.keys(claudeConfig.mcpServers).length > 0) {
            console.log(`✅ Found ${Object.keys(claudeConfig.mcpServers).length} global MCP servers`);
            hasMcpServers = true;
          }
          
          // Check project-specific MCP servers
          if (!hasMcpServers && claudeConfig.claudeProjects) {
            const currentProjectPath = process.cwd();
            const projectConfig = claudeConfig.claudeProjects[currentProjectPath];
            if (projectConfig && projectConfig.mcpServers && Object.keys(projectConfig.mcpServers).length > 0) {
              console.log(`✅ Found ${Object.keys(projectConfig.mcpServers).length} project MCP servers`);
              hasMcpServers = true;
            }
          }
        } catch (e) {
          console.log(`❌ Failed to parse Claude config:`, e.message);
        }
      }
      
      console.log(`🔍 hasMcpServers result: ${hasMcpServers}`);
      
      if (hasMcpServers) {
        // Use Claude config file if it has MCP servers
        let configPath = null;
        
        if (fsSync.existsSync(claudeConfigPath)) {
          try {
            const claudeConfig = JSON.parse(fsSync.readFileSync(claudeConfigPath, 'utf8'));
            
            // Check if we have any MCP servers (global or project-specific)
            const hasGlobalServers = claudeConfig.mcpServers && Object.keys(claudeConfig.mcpServers).length > 0;
            const currentProjectPath = process.cwd();
            const projectConfig = claudeConfig.claudeProjects && claudeConfig.claudeProjects[currentProjectPath];
            const hasProjectServers = projectConfig && projectConfig.mcpServers && Object.keys(projectConfig.mcpServers).length > 0;
            
            if (hasGlobalServers || hasProjectServers) {
              configPath = claudeConfigPath;
            }
          } catch (e) {
            // No valid config found
          }
        }
        
        if (configPath) {
          console.log(`📡 Adding MCP config: ${configPath}`);
          args.push('--mcp-config', configPath);
        } else {
          console.log('⚠️ MCP servers detected but no valid config file found');
        }
      }
    } catch (error) {
      // If there's any error checking for MCP configs, don't add the flag
      console.log('❌ MCP config check failed:', error.message);
      console.log('📍 Error stack:', error.stack);
      console.log('Note: MCP config check failed, proceeding without MCP support');
    }
    
    // Add model for new sessions
    if (!resume) {
      args.push('--model', 'sonnet');
    }
    
    // Add permission mode if specified (works for both new and resumed sessions)
    if (permissionMode && permissionMode !== 'default') {
      args.push('--permission-mode', permissionMode);
      console.log('🔒 Using permission mode:', permissionMode);
    }
    
    // Add tools settings flags
    // Don't use --dangerously-skip-permissions when in plan mode
    if (settings.skipPermissions && permissionMode !== 'plan') {
      args.push('--dangerously-skip-permissions');
      console.log('⚠️  Using --dangerously-skip-permissions (skipping other tool settings)');
    } else {
      // Only add allowed/disallowed tools if not skipping permissions
      
      // Collect all allowed tools, including plan mode defaults
      let allowedTools = [...(settings.allowedTools || [])];
      
      // Add plan mode specific tools
      if (permissionMode === 'plan') {
        const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite'];
        // Add plan mode tools that aren't already in the allowed list
        for (const tool of planModeTools) {
          if (!allowedTools.includes(tool)) {
            allowedTools.push(tool);
          }
        }
        console.log('📝 Plan mode: Added default allowed tools:', planModeTools);
      }
      
      // Add allowed tools
      if (allowedTools.length > 0) {
        for (const tool of allowedTools) {
          args.push('--allowedTools', tool);
          console.log('✅ Allowing tool:', tool);
        }
      }
      
      // Add disallowed tools
      if (settings.disallowedTools && settings.disallowedTools.length > 0) {
        for (const tool of settings.disallowedTools) {
          args.push('--disallowedTools', tool);
          console.log('❌ Disallowing tool:', tool);
        }
      }
      
      // Log when skip permissions is disabled due to plan mode
      if (settings.skipPermissions && permissionMode === 'plan') {
        console.log('📝 Skip permissions disabled due to plan mode');
      }
    }
    
    console.log('Spawning Claude CLI:', 'claude', args.map(arg => {
      const cleanArg = arg.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      return cleanArg.includes(' ') ? `"${cleanArg}"` : cleanArg;
    }).join(' '));
    console.log('Working directory:', workingDir);
    console.log('Session info - Input sessionId:', sessionId, 'Resume:', resume);
    console.log('🔍 Full command args:', JSON.stringify(args, null, 2));
    console.log('🔍 Final Claude command will be: claude ' + args.join(' '));
    const processKey = capturedSessionId || sessionId || Date.now().toString();

    const handleStdout = (data) => {
      const rawOutput = data.toString();
      console.log('📤 Claude CLI stdout:', rawOutput);
      const lines = rawOutput.split('\n').filter(line => line.trim());
      for (const line of lines) {
        try {
          const response = JSON.parse(line);
          console.log('📄 Parsed JSON response:', response);
          if (response.session_id && !capturedSessionId) {
            capturedSessionId = response.session_id;
            console.log('📝 Captured session ID:', capturedSessionId);
            const existing = activeClaudeProcesses.get(processKey);
            if (existing && processKey !== capturedSessionId) {
              activeClaudeProcesses.delete(processKey);
              activeClaudeProcesses.set(capturedSessionId, existing);
            }
            if (!sessionId && !sessionCreatedSent) {
              sessionCreatedSent = true;
              ws.send(JSON.stringify({ type: 'session-created', sessionId: capturedSessionId }));
            }
          }
          ws.send(JSON.stringify({ type: 'claude-response', data: response }));
        } catch (parseError) {
          console.log('📄 Non-JSON response:', line);
          ws.send(JSON.stringify({ type: 'claude-output', data: line }));
        }
      }
    };

    const handleStderr = (data) => {
      console.error('Claude CLI stderr:', data.toString());
      ws.send(JSON.stringify({ type: 'claude-error', error: data.toString() }));
    };

    if (sshConfig) {
      try {
        const ssh = new NodeSSH();
        await ssh.connect(sshConfig);

        if (localImagePaths.length > 0) {
          await ssh.execCommand(`mkdir -p ${remoteTempDir}`);
          for (const img of localImagePaths) {
            await ssh.putFile(img.local, img.remote);
          }
        }

        activeClaudeProcesses.set(processKey, { type: 'ssh', ssh, channel: null });

        const result = await ssh.exec('claude', args, {
          cwd: workingDir,
          stream: 'both',
          onChannel: (channel) => {
            const info = activeClaudeProcesses.get(processKey);
            if (info) info.channel = channel;
          },
          onStdout: handleStdout,
          onStderr: handleStderr,
        });

        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeClaudeProcesses.delete(finalSessionId);

        ws.send(JSON.stringify({
          type: 'claude-complete',
          exitCode: result.code,
          isNewSession: !sessionId && !!command
        }));

        if (localImagePaths.length > 0) {
          for (const img of localImagePaths) {
            await fs.unlink(img.local).catch(err => console.error(`Failed to delete temp image ${img.local}:`, err));
          }
          if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(err => console.error(`Failed to delete temp dir ${tempDir}:`, err));
          }
          if (remoteTempDir) {
            await ssh.execCommand(`rm -rf ${remoteTempDir}`).catch(err => console.error(`Failed to delete remote temp dir ${remoteTempDir}:`, err.message));
          }
        }

        ssh.dispose();
        if (result.code === 0) {
          resolve();
        } else {
          reject(new Error(`Claude CLI exited with code ${result.code}`));
        }
      } catch (error) {
        console.error('Claude CLI process error:', error);
        activeClaudeProcesses.delete(processKey);
        ws.send(JSON.stringify({ type: 'claude-error', error: error.message }));
        reject(error);
      }
    } else {
      const claudeProcess = spawnFunction('claude', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      claudeProcess.tempImagePaths = tempImagePaths;
      claudeProcess.tempDir = tempDir;
      activeClaudeProcesses.set(processKey, { type: 'local', process: claudeProcess });

      claudeProcess.stdout.on('data', handleStdout);
      claudeProcess.stderr.on('data', handleStderr);

      claudeProcess.on('close', async (code) => {
        console.log(`Claude CLI process exited with code ${code}`);
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeClaudeProcesses.delete(finalSessionId);
        ws.send(JSON.stringify({
          type: 'claude-complete',
          exitCode: code,
          isNewSession: !sessionId && !!command
        }));

        if (claudeProcess.tempImagePaths && claudeProcess.tempImagePaths.length > 0) {
          for (const imagePath of claudeProcess.tempImagePaths) {
            await fs.unlink(imagePath).catch(err => console.error(`Failed to delete temp image ${imagePath}:`, err));
          }
          if (claudeProcess.tempDir) {
            await fs.rm(claudeProcess.tempDir, { recursive: true, force: true }).catch(err => console.error(`Failed to delete temp directory ${claudeProcess.tempDir}:`, err));
          }
        }

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Claude CLI exited with code ${code}`));
        }
      });

      claudeProcess.on('error', (error) => {
        console.error('Claude CLI process error:', error);
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeClaudeProcesses.delete(finalSessionId);
        ws.send(JSON.stringify({ type: 'claude-error', error: error.message }));
        reject(error);
      });

      if (command) {
        claudeProcess.stdin.end();
      } else {
        if (command !== undefined) {
          claudeProcess.stdin.write(command + '\n');
          claudeProcess.stdin.end();
        }
      }
    }
  });
}

function abortClaudeSession(sessionId) {
  const entry = activeClaudeProcesses.get(sessionId);
  if (entry) {
    console.log(`🛑 Aborting Claude session: ${sessionId}`);
    try {
      if (entry.type === 'ssh' && entry.channel) {
        entry.channel.signal('TERM');
        entry.ssh.dispose();
      } else if (entry.type === 'local' && entry.process) {
        entry.process.kill('SIGTERM');
      }
    } catch (err) {
      console.error('Error aborting session:', err);
    }
    activeClaudeProcesses.delete(sessionId);
    return true;
  }
  return false;
}

export {
  spawnClaude,
  abortClaudeSession
};
