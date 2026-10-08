// Exercise the installed Codex CLI with synthetic history, no real account or model calls.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), {randomUUID} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sbt-real-codex-'));
const home = path.join(state, 'home'), id = randomUUID();
const env = {...process.env, TMUX_TMPDIR: state}; delete env.TMUX;
const python = process.env.PYTHON || 'python3';
const tmux = (...args) => execFileSync('tmux', args, {env, encoding: 'utf8'}).trim();
const setup = String.raw`
import sys,socket
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'scripts'))
import browser_terminal as t
s=Path(sys.argv[2])
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
c={'session':'codex-bottom-test','port':port,'font_size':14,'cwd':str(s)}
t.prepare_state(s);t.save_config(s,c);t.ensure_credentials(s);t.restart_ttyd(s,c)
`;
(async () => {
  let browser, started = false;
  try {
    const directory = path.join(home, 'sessions', '2026', '10', '08');
    fs.mkdirSync(directory, {recursive: true});
    const timestamp = '2026-10-08T12:00:00Z';
    const events = [{type: 'session_meta', payload: {id, timestamp, cwd: state,
      originator: 'codex_cli_rs', cli_version: '0.162.0', source: 'cli', model_provider: 'openai'}}];
    for (let i = 0; i < 80; i++) {
      for (const role of ['user', 'assistant']) {
        const message = `Synthetic ${role === 'user' ? 'question' : 'answer'} ${String(i).padStart(3, '0')}`;
        events.push({type: 'response_item', payload: {type: 'message', role,
          content: [{type: role === 'user' ? 'input_text' : 'output_text', text: message}]}});
        events.push({type: 'event_msg', payload: role === 'user' ?
          {type: 'user_message', message, images: []} : {type: 'agent_message', message}});
      }
    }
    fs.writeFileSync(path.join(directory, `rollout-2026-10-08T12-00-00-${id}.jsonl`),
      events.map(event => JSON.stringify({timestamp, ...event})).join('\n') + '\n');
    fs.writeFileSync(path.join(home, 'config.toml'),
      `model="gpt-5"\ncheck_for_update_on_startup=false\n[projects.${JSON.stringify(state)}]\ntrust_level="trusted"\n`);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({OPENAI_API_KEY: 'offline-ui-test-unused'}), {mode: 0o600});
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'codex-bottom-test', '-x', '140', '-y', '40', '-c', state,
      'env', `CODEX_HOME=${home}`, 'OPENAI_API_KEY=offline-ui-test-unused', 'OPENAI_BASE_URL=http://127.0.0.1:1/v1',
      process.env.CODEX_BINARY || 'codex', '--no-daemon', 'resume', id);
    started = true;
    execFileSync(python, ['-c', setup, root, state], {env});
    const config = JSON.parse(fs.readFileSync(path.join(state, 'settings.json'), 'utf8'));
    const login = fs.readFileSync(path.join(state, 'login.txt'), 'utf8').trim(), colon = login.indexOf(':');
    browser = await chromium.launch({headless: true});
    const page = await browser.newPage({viewport: {width: 1400, height: 900},
      httpCredentials: {username: login.slice(0, colon), password: login.slice(colon + 1)}});
    await page.goto(`http://127.0.0.1:${config.port}`);
    const visible = text => page.waitForFunction(text => {
      const term = window.term;
      if (!term) return false;
      return Array.from({length: term.rows}, (_, i) => term.buffer.active.getLine(i)?.translateToString() || '').join('\n').includes(text);
    }, text, {timeout: 15000});
    await visible('Synthetic answer 079');
    const pane = tmux('display-message', '-p', '-t', '=codex-bottom-test:', '#{pane_id}');
    const paneProcess = tmux('display-message', '-p', '-t', pane, '#{pane_pid}');
    assert.equal(tmux('display-message', '-p', '-t', pane, '#{alternate_on} #{mouse_any_flag}'), '1 0',
      'regression setup must use real Codex fullscreen without mouse capture');
    tmux('send-keys', '-t', pane, '-l', 'KEEP THIS UNSUBMITTED DRAFT');
    await visible('KEEP THIS UNSUBMITTED DRAFT');
    for (const copyMode of [false, true]) {
      tmux('send-keys', '-t', pane, 'C-Home');
      await visible('Synthetic question 000');
      if (copyMode) tmux('copy-mode', '-t', pane);
      await page.getByRole('button', {name: 'Scroll to bottom', exact: true}).click();
      await visible('Synthetic answer 079');
      await visible('KEEP THIS UNSUBMITTED DRAFT');
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_in_mode}'), '0');
    }
    tmux('send-keys', '-t', pane, 'C-Home');
    await visible('Synthetic question 000');
    await page.evaluate(() => window.sharedTerminalPrepareInput());
    await visible('Synthetic question 000');
    await visible('KEEP THIS UNSUBMITTED DRAFT');
    assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_pid}'), paneProcess);
    console.log('PASS: real Codex without mouse capture reaches the latest transcript through the browser button, including from tmux copy mode; draft and process survive; upload preparation does not scroll the app.');
  } finally {
    if (browser) await browser.close();
    try {
      execFileSync(python, ['-c', "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;s=Path(sys.argv[2]);t.stop_process(s,t.read_config(s),'ttyd')", path.join(root, 'scripts'), state], {env});
    } finally {
      try {if (started) tmux('kill-server');} finally {fs.rmSync(state, {recursive: true, force: true});}
    }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
