/**
 * 配置迁移工具
 * 用于在换机时迁移用户配置和数据
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

class ConfigMigrationTool {
    constructor() {
        this.userDataPath = app.getPath('userData');
        this.configPath = path.join(os.homedir(), '.simona-desktop', 'env-config.json');
    }

    /**
     * 导出完整配置包（包括环境配置和用户数据）
     */
    async exportFullConfig(exportPath) {
        try {
            const archiver = require('archiver');
            const zipDest = exportPath || path.join(os.homedir(), 'Desktop', 'simona-desktop-config-backup.zip');
            
            return new Promise((resolve, reject) => {
                const output = fs.createWriteStream(zipDest);
                const archive = archiver('zip', { zlib: { level: 9 } });

                output.on('close', () => {
                    console.log('[Migration] 配置包导出成功:', zipDest);
                    resolve({ success: true, path: zipDest, size: archive.pointer() });
                });

                archive.on('error', (err) => {
                    reject(err);
                });

                archive.pipe(output);

                // 添加环境配置文件
                if (fs.existsSync(this.configPath)) {
                    archive.file(this.configPath, { name: 'env-config.json' });
                }

                // 添加用户数据目录
                if (fs.existsSync(this.userDataPath)) {
                    archive.directory(this.userDataPath, 'user-data/');
                }

                archive.finalize();
            });
        } catch (error) {
            console.error('[Migration] 导出配置包失败:', error.message);
            throw error;
        }
    }

    /**
     * 导入完整配置包
     */
    async importFullConfig(importPath) {
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(importPath);
            
            // 解压到临时目录
            const tempDir = path.join(os.tmpdir(), `simona-desktop-import-${Date.now()}`);
            zip.extractAllTo(tempDir, true);

            // 恢复环境配置
            const envConfigPath = path.join(tempDir, 'env-config.json');
            if (fs.existsSync(envConfigPath)) {
                const configDir = path.dirname(this.configPath);
                if (!fs.existsSync(configDir)) {
                    fs.mkdirSync(configDir, { recursive: true });
                }
                fs.copyFileSync(envConfigPath, this.configPath);
                console.log('[Migration] 环境配置恢复成功');
            }

            // 恢复用户数据
            const userDataDir = path.join(tempDir, 'user-data');
            if (fs.existsSync(userDataDir)) {
                this.copyDirectory(userDataDir, this.userDataPath);
                console.log('[Migration] 用户数据恢复成功');
            }

            // 清理临时目录
            this.deleteDirectory(tempDir);

            return { success: true };
        } catch (error) {
            console.error('[Migration] 导入配置包失败:', error.message);
            throw error;
        }
    }

    /**
     * 复制目录
     */
    copyDirectory(src, dest) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }

        const entries = fs.readdirSync(src, { withFileTypes: true });

        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);

            if (entry.isDirectory()) {
                this.copyDirectory(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    /**
     * 删除目录
     */
    deleteDirectory(dirPath) {
        if (fs.existsSync(dirPath)) {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    this.deleteDirectory(fullPath);
                } else {
                    fs.unlinkSync(fullPath);
                }
            }

            fs.rmdirSync(dirPath);
        }
    }

    /**
     * 验证配置完整性
     */
    validateConfig(config) {
        const requiredFields = [
            'SIMONA_MODEL',
            'user_mode',
            'last_machine_id',
            'config_version'
        ];

        const missingFields = requiredFields.filter(field => !config[field]);
        
        return {
            isValid: missingFields.length === 0,
            missingFields
        };
    }
}

module.exports = ConfigMigrationTool;
