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
const selectionTest = process.argv.includes('--selection');
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
t.prepare_state(s)
if sys.argv[3] == 'selection': t.apply_tmux_theme(t.find_session(c['session']))
t.save_config(s,c);t.ensure_credentials(s);t.restart_ttyd(s,c)
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
    execFileSync(python, ['-c', setup, root, state, selectionTest ? 'selection' : 'bottom'], {env});
    const config = JSON.parse(fs.readFileSync(path.join(state, 'settings.json'), 'utf8'));
    const login = fs.readFileSync(path.join(state, 'login.txt'), 'utf8').trim(), colon = login.indexOf(':');
    browser = await chromium.launch({headless: true});
    const page = await browser.newPage({viewport: {width: 1400, height: 900},
      httpCredentials: {username: login.slice(0, colon), password: login.slice(colon + 1)},
      permissions: ['clipboard-read', 'clipboard-write']});
    await page.goto(`http://127.0.0.1:${config.port}`);
    const visible = text => page.waitForFunction(text => {
      const term = window.term;
      if (!term) return false;
      return Array.from({length: term.rows}, (_, i) => term.buffer.active.getLine(i)?.translateToString() || '').join('\n').includes(text);
    }, text, {timeout: 15000});
    await visible('Synthetic answer 079');
    const pane = tmux('display-message', '-p', '-t', '=codex-bottom-test:', '#{pane_id}');
    const paneProcess = tmux('display-message', '-p', '-t', pane, '#{pane_pid}');
    assert.equal(tmux('display-message', '-p', '-t', pane, '#{alternate_on}'), '1',
      'regression setup must use real Codex fullscreen');
    if (!selectionTest) assert.equal(tmux('display-message', '-p', '-t', pane, '#{mouse_any_flag}'), '0', 'bottom regression tests Codex without mouse capture');
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
    // Exercise real pointer drags against Codex's application-owned history.
    const capture = () => tmux('capture-pane', '-p', '-t', pane);
    for (const direction of selectionTest ? [1, -1] : []) {
      tmux('send-keys', '-t', pane, direction > 0 ? 'C-Home' : 'C-End');
      await visible(direction > 0 ? 'Synthetic question 000' : 'Synthetic answer 079');
      const geometry = await page.evaluate(direction => {
        const t = window.term, rect = t.element.querySelector('.xterm-screen').getBoundingClientRect();
        const rows = Array.from({length: t.rows}, (_, i) => t.buffer.active.getLine(i)?.translateToString() || '');
        const candidates = rows.map((text, row) => ({text, row})).filter(item => item.text.includes('Synthetic'));
        const anchor = direction > 0 ? candidates[0] : candidates[candidates.length - 1];
        return {x: rect.x, top: rect.top, bottom: rect.bottom, cellWidth: rect.width / t.cols,
          cellHeight: rect.height / t.rows, anchor, rows: t.rows};
      }, direction);
      await page.evaluate(() => navigator.clipboard.writeText('keep clipboard during drag'));
      await page.mouse.move(geometry.x + (direction > 0 ? .1 : 35) * geometry.cellWidth, geometry.top + (geometry.anchor.row + .5) * geometry.cellHeight);
      await page.mouse.down();
      await page.mouse.move(geometry.x + 35 * geometry.cellWidth, direction > 0 ? geometry.bottom - geometry.cellHeight / 2 : geometry.top + geometry.cellHeight / 2, {steps: 8});
      await page.waitForFunction(() => {
        // Read the selection through the copy handler without modifying the OS
        // clipboard. A transient partially painted viewport is not completion.
        const clipboardData = new DataTransfer();
        document.dispatchEvent(new ClipboardEvent('copy', {clipboardData}));
        return [...clipboardData.getData('text/plain').matchAll(/Synthetic (?:question|answer) (\d+)/g)].length >= 30;
      }, null, {timeout: 30000}).catch(error => {
        throw new Error(`Codex drag did not extend the selection (${direction}): ${capture()}`, {cause:error});
      });
      await page.mouse.up();
      await page.waitForTimeout(500);
      const stopped = capture();
      await page.waitForTimeout(500);
      assert.equal(capture(), stopped, 'scrolling stops on release');
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'keep clipboard during drag');
      await page.keyboard.press('Meta+c');
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert(copied.includes(geometry.anchor.text.trim()), `selection retains its original anchor (${direction})`);
      assert(!copied.includes('KEEP THIS UNSUBMITTED DRAFT'), 'selection excludes the composer');
      const ids = [...copied.matchAll(/Synthetic (?:question|answer) (\d+)/g)].map(match => Number(match[1]));
      assert(ids.length >= 24, `drag selection extends over multiple Codex viewports (${direction}): ${copied}`);
      const entries = [...copied.matchAll(/Synthetic (question|answer) (\d+)/g)].map(match => 2 * Number(match[2]) + (match[1] === 'answer' ? 1 : 0));
      for (let i = 1; i < entries.length; i++) assert.equal(entries[i], entries[i-1] + 1, 'copied transcript stays ordered without gaps or duplicates');
      await visible('KEEP THIS UNSUBMITTED DRAFT');
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_in_mode}'), '0');
      assert.equal(tmux('display-message', '-p', '-t', pane, '#{pane_pid}'), paneProcess);
      await page.keyboard.press('Escape');
    }
    if (selectionTest) console.log('PASS: real Codex supports drag scrolling in both directions, copies continuous multi-screen history, stops on release, and preserves the draft and process.');
    console.log('PASS: real Codex reaches the latest transcript through the browser button, including from tmux copy mode; draft and process survive; upload preparation does not scroll the app.');
  } finally {
    if (browser) await browser.close();
    try {
      execFileSync(python, ['-c', "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import browser_terminal as t;s=Path(sys.argv[2]);t.stop_process(s,t.read_config(s),'ttyd')", path.join(root, 'scripts'), state], {env});
    } finally {
      try {if (started) tmux('kill-server');} finally {fs.rmSync(state, {recursive: true, force: true});}
    }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
