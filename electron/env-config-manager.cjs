/**
 * 环境变量配置管理器
 * 用于处理换机后的环境配置迁移和初始化
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class EnvConfigManager {
    constructor() {
        this.configPath = path.join(os.homedir(), '.simona-desktop', 'env-config.json');
        this.defaultConfig = {
            // API 配置
            SIMONA_API_KEY: '',
            SIMONA_BASE_URL: '',
            SIMONA_MODEL: 'simona-sonnet-4-6',
            SIMONA_DEFAULT_SONNET_MODEL: 'simona-sonnet-4-6',
            SIMONA_DEFAULT_HAIKU_MODEL: 'simona-haiku-4-5-20251001',
            SIMONA_DEFAULT_OPUS_MODEL: 'simona-opus-4-6',
            
            // 超时配置
            API_TIMEOUT_MS: 300000,
            
            // 功能开关
            DISABLE_TELEMETRY: 1,
            SIMONA_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
            SIMONA_CODE_DISABLE_THINKING: 1,
            
            // 用户模式
            user_mode: 'selfhosted', // 'selfhosted' or 'clawparrot'
            
            // 网关用户信息（clawparrot 模式）
            gateway_user: '',
            
            // 其他配置
            last_machine_id: this.getMachineId(),
            config_version: '1.0.0'
        };
    }

    /**
     * 获取机器唯一标识
     */
    getMachineId() {
        const crypto = require('crypto');
        const machineInfo = os.hostname() + os.platform() + os.arch();
        return crypto.createHash('md5').update(machineInfo).digest('hex');
    }

    /**
     * 加载配置文件
     */
    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const configData = fs.readFileSync(this.configPath, 'utf8');
                const loadedConfig = JSON.parse(configData);
                
                // 合并默认配置，确保新添加的配置项存在
                const mergedConfig = { ...this.defaultConfig, ...loadedConfig };
                
                console.log('[EnvConfig] 配置文件加载成功');
                return mergedConfig;
            } else {
                console.log('[EnvConfig] 配置文件不存在，创建默认配置');
                this.saveConfig(this.defaultConfig);
                return this.defaultConfig;
            }
        } catch (error) {
            console.error('[EnvConfig] 加载配置文件失败:', error.message);
            return this.defaultConfig;
        }
    }

    /**
     * 保存配置文件
     */
    saveConfig(config) {
        try {
            const configDir = path.dirname(this.configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            
            fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
            console.log('[EnvConfig] 配置文件保存成功');
            return true;
        } catch (error) {
            console.error('[EnvConfig] 保存配置文件失败:', error.message);
            return false;
        }
    }

    /**
     * 检测是否是新机器
     */
    isNewMachine() {
        const config = this.loadConfig();
        const currentMachineId = this.getMachineId();
        return config.last_machine_id !== currentMachineId;
    }

    /**
     * 更新机器标识
     */
    updateMachineId() {
        const config = this.loadConfig();
        config.last_machine_id = this.getMachineId();
        this.saveConfig(config);
    }

    /**
     * 导出配置为环境变量格式
     */
    exportToEnvFormat(config) {
        let envContent = '# Simona Desktop Environment Configuration\n';
        envContent += `# Generated on ${new Date().toISOString()}\n`;
        envContent += `# Machine ID: ${this.getMachineId()}\n\n`;
        
        for (const [key, value] of Object.entries(config)) {
            if (key.startsWith('_') || key === 'last_machine_id' || key === 'config_version') {
                continue; // 跳过内部字段
            }
            envContent += `${key}=${value}\n`;
        }
        
        return envContent;
    }

    /**
     * 从 .env 文件导入配置
     */
    importFromEnvFile(envFilePath) {
        try {
            if (!fs.existsSync(envFilePath)) {
                console.warn('[EnvConfig] .env 文件不存在:', envFilePath);
                return null;
            }
            
            const envContent = fs.readFileSync(envFilePath, 'utf8');
            const config = this.loadConfig();
            
            envContent.split('\n').forEach(line => {
                line = line.trim();
                if (line && !line.startsWith('#')) {
                    const [key, ...valueParts] = line.split('=');
                    if (key && valueParts.length > 0) {
                        const value = valueParts.join('=').trim();
                        config[key.trim()] = value;
                    }
                }
            });
            
            this.saveConfig(config);
            console.log('[EnvConfig] 从 .env 文件导入配置成功');
            return config;
        } catch (error) {
            console.error('[EnvConfig] 从 .env 文件导入配置失败:', error.message);
            return null;
        }
    }

    /**
     * 创建配置备份
     */
    createBackup() {
        try {
            const config = this.loadConfig();
            const backupPath = this.configPath.replace('.json', `.backup.${Date.now()}.json`);
            fs.writeFileSync(backupPath, JSON.stringify(config, null, 2), 'utf8');
            console.log('[EnvConfig] 配置备份创建成功:', backupPath);
            return backupPath;
        } catch (error) {
            console.error('[EnvConfig] 创建配置备份失败:', error.message);
            return null;
        }
    }

    /**
     * 恢复配置备份
     */
    restoreFromBackup(backupPath) {
        try {
            if (!fs.existsSync(backupPath)) {
                console.error('[EnvConfig] 备份文件不存在:', backupPath);
                return false;
            }
            
            const backupData = fs.readFileSync(backupPath, 'utf8');
            const backupConfig = JSON.parse(backupData);
            this.saveConfig(backupConfig);
            console.log('[EnvConfig] 配置恢复成功');
            return true;
        } catch (error) {
            console.error('[EnvConfig] 恢复配置备份失败:', error.message);
            return false;
        }
    }
}

// 如果直接运行此脚本，执行配置管理操作
if (require.main === module) {
    const manager = new EnvConfigManager();
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('使用方法:');
        console.log('  node env-config-manager.js load          - 加载并显示当前配置');
        console.log('  node env-config-manager.js export <file>  - 导出配置到指定文件');
        console.log('  node env-config-manager.js import <file>  - 从指定文件导入配置');
        console.log('  node env-config-manager.js backup         - 创建配置备份');
        console.log('  node env-config-manager.js check-machine  - 检查是否为新机器');
        console.log('  node env-config-manager.js update-machine - 更新机器标识');
        return;
    }
    
    const command = args[0];
    
    switch (command) {
        case 'load':
            const config = manager.loadConfig();
            console.log('当前配置:');
            console.log(JSON.stringify(config, null, 2));
            break;
            
        case 'export':
            if (args[1]) {
                const config = manager.loadConfig();
                const envContent = manager.exportToEnvFormat(config);
                fs.writeFileSync(args[1], envContent, 'utf8');
                console.log('配置已导出到:', args[1]);
            } else {
                console.log('请指定导出文件路径');
            }
            break;
            
        case 'import':
            if (args[1]) {
                manager.importFromEnvFile(args[1]);
            } else {
                console.log('请指定导入文件路径');
            }
            break;
            
        case 'backup':
            manager.createBackup();
            break;
            
        case 'check-machine':
            const isNew = manager.isNewMachine();
            console.log(isNew ? '检测到新机器' : '当前机器');
            break;
            
        case 'update-machine':
            manager.updateMachineId();
            console.log('机器标识已更新');
            break;
            
        default:
            console.log('未知命令:', command);
    }
}

module.exports = EnvConfigManager;
