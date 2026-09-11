/**
 * Teams API Routes - 团队协作API
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

module.exports = function createTeamsRouter(app, userDataPath) {
  const router = express.Router();
  const teamsDir = path.join(userDataPath, 'teams');

  // 确保团队目录存在
  if (!fs.existsSync(teamsDir)) {
    fs.mkdirSync(teamsDir, { recursive: true });
  }

  // GET /api/teams - 获取所有团队
  router.get('/', (req, res) => {
    try {
      const teams = [];
      
      if (fs.existsSync(teamsDir)) {
        const teamFiles = fs.readdirSync(teamsDir).filter(f => f.endsWith('.json'));
        
        for (const file of teamFiles) {
          try {
            const teamData = JSON.parse(fs.readFileSync(path.join(teamsDir, file), 'utf8'));
            teams.push(teamData);
          } catch (e) {
            console.error(`[Teams] Failed to read team file ${file}:`, e.message);
          }
        }
      }

      res.json({ teams });
    } catch (error) {
      console.error('[Teams] Failed to get teams:', error);
      res.status(500).json({ error: 'Failed to get teams' });
    }
  });

  // POST /api/teams - 创建新团队
  router.post('/', (req, res) => {
    try {
      const { operation, team_name, description, agent_type } = req.body;

      if (operation !== 'spawnTeam') {
        return res.status(400).json({ error: 'Invalid operation' });
      }

      if (!team_name) {
        return res.status(400).json({ error: 'team_name is required' });
      }

      const teamFile = path.join(teamsDir, `${team_name}.json`);
      
      // 检查团队是否已存在
      if (fs.existsSync(teamFile)) {
        return res.status(409).json({ error: 'Team already exists' });
      }

      // 创建团队文件
      const teamData = {
        name: team_name,
        description: description || '',
        createdAt: Date.now(),
        leadAgentId: `lead-${Date.now()}`,
        members: [],
        hiddenPaneIds: [],
        teamAllowedPaths: []
      };

      fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2), 'utf8');

      res.json({
        team_name: team_name,
        team_file_path: teamFile,
        lead_agent_id: teamData.leadAgentId
      });
    } catch (error) {
      console.error('[Teams] Failed to create team:', error);
      res.status(500).json({ error: 'Failed to create team' });
    }
  });

  // GET /api/teams/:teamName - 获取特定团队
  router.get('/:teamName', (req, res) => {
    try {
      const { teamName } = req.params;
      const teamFile = path.join(teamsDir, `${teamName}.json`);

      if (!fs.existsSync(teamFile)) {
        return res.status(404).json({ error: 'Team not found' });
      }

      const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
      res.json(teamData);
    } catch (error) {
      console.error('[Teams] Failed to get team:', error);
      res.status(500).json({ error: 'Failed to get team' });
    }
  });

  // POST /api/teams/:teamName/members - 添加团队成员
  router.post('/:teamName/members', (req, res) => {
    try {
      const { teamName } = req.params;
      const { name, agentType, model, prompt, mode } = req.body;
      const teamFile = path.join(teamsDir, `${teamName}.json`);

      if (!fs.existsSync(teamFile)) {
        return res.status(404).json({ error: 'Team not found' });
      }

      const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));

      // 创建新成员
      const newMember = {
        agentId: `agent-${Date.now()}`,
        name: name || `Teammate-${teamData.members.length + 1}`,
        agentType,
        model,
        prompt,
        mode: mode || 'default',
        joinedAt: Date.now(),
        tmuxPaneId: `pane-${Date.now()}`,
        cwd: process.cwd(),
        subscriptions: [],
        isActive: true
      };

      teamData.members.push(newMember);
      fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2), 'utf8');

      res.json(newMember);
    } catch (error) {
      console.error('[Teams] Failed to add member:', error);
      res.status(500).json({ error: 'Failed to add member' });
    }
  });

  // POST /api/teams/:teamName/members/:memberName/mode - 切换成员模式
  router.post('/:teamName/members/:memberName/mode', (req, res) => {
    try {
      const { teamName, memberName } = req.params;
      const { action } = req.body;
      const teamFile = path.join(teamsDir, `${teamName}.json`);

      if (!fs.existsSync(teamFile)) {
        return res.status(404).json({ error: 'Team not found' });
      }

      const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
      const member = teamData.members.find(m => m.name === memberName);

      if (!member) {
        return res.status(404).json({ error: 'Member not found' });
      }

      // 循环切换模式: default -> acceptEdits -> bypassPermissions -> default
      const modes = ['default', 'acceptEdits', 'bypassPermissions'];
      const currentIndex = modes.indexOf(member.mode || 'default');
      const nextIndex = (currentIndex + 1) % modes.length;
      member.mode = modes[nextIndex];

      fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2), 'utf8');

      res.json({ mode: member.mode });
    } catch (error) {
      console.error('[Teams] Failed to cycle mode:', error);
      res.status(500).json({ error: 'Failed to cycle mode' });
    }
  });

  // DELETE /api/teams/:teamName/members/:memberName - 删除团队成员
  router.delete('/:teamName/members/:memberName', (req, res) => {
    try {
      const { teamName, memberName } = req.params;
      const teamFile = path.join(teamsDir, `${teamName}.json`);

      if (!fs.existsSync(teamFile)) {
        return res.status(404).json({ error: 'Team not found' });
      }

      const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
      const memberIndex = teamData.members.findIndex(m => m.name === memberName);

      if (memberIndex === -1) {
        return res.status(404).json({ error: 'Member not found' });
      }

      const removedMember = teamData.members.splice(memberIndex, 1)[0];
      fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2), 'utf8');

      res.json({ success: true, removed: removedMember });
    } catch (error) {
      console.error('[Teams] Failed to remove member:', error);
      res.status(500).json({ error: 'Failed to remove member' });
    }
  });

  // DELETE /api/teams/:teamName - 删除团队
  router.delete('/:teamName', (req, res) => {
    try {
      const { teamName } = req.params;
      const teamFile = path.join(teamsDir, `${teamName}.json`);

      if (!fs.existsSync(teamFile)) {
        return res.status(404).json({ error: 'Team not found' });
      }

      fs.unlinkSync(teamFile);

      res.json({ success: true, message: `Team ${teamName} deleted` });
    } catch (error) {
      console.error('[Teams] Failed to delete team:', error);
      res.status(500).json({ error: 'Failed to delete team' });
    }
  });

  return router;
};
