const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const packageInfo = require('../package.json');
const root = path.resolve(__dirname, '..');
const testRoot = path.join(root, '.test-data', 'desktop-' + Date.now());
(async () => {
  await fs.mkdir(testRoot, {recursive:true});
  const scanRoot = path.join(testRoot, 'scan');
  const fixtureHome = path.join(testRoot, 'home');
  await fs.mkdir(path.join(fixtureHome, '.codex'), {recursive:true});
  await fs.mkdir(path.join(fixtureHome, '.claude'), {recursive:true});
  await fs.mkdir(path.join(scanRoot, 'auto-helper'), {recursive:true});
  await fs.writeFile(path.join(scanRoot, 'auto-helper', 'SKILL.md'), '---\nname: autodetected-helper\ndescription: Discovered from a local folder\n---\n\n# Automatic discovery\nReview instructions.');
  const app = await electron.launch({
    executablePath:process.env.SKILL_HUB_EXECUTABLE || path.join(root,'node_modules/electron/dist/electron.exe'), args:process.env.SKILL_HUB_EXECUTABLE ? [] : [root],
    env:{...process.env,SKILL_HUB_TEST_DATA:path.join(testRoot,'data'),SKILL_HUB_TEST_MODE:'1',SKILL_HUB_TEST_SCAN_ROOT:scanRoot,SKILL_HUB_TEST_HOME:fixtureHome}
  });
  try {
    const page=await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.getByRole('heading',{name:'คลัง Skill',exact:true}).waitFor();
    assert.equal((await page.locator('.app-version').textContent()).trim(), `Skill Hub · Windows · v${packageInfo.version}`);
    assert.equal(await page.locator('.preview-banner').count(),0);
    const initial=await page.evaluate(()=>window.skillHub.getState());
    assert.equal(initial.skills.length,0); assert.equal(initial.profiles.length,4);
    await page.getByRole('button',{name:'สร้าง Skill แรก',exact:true}).click();
    await page.getByLabel('ชื่อ Skill',{exact:true}).fill('Review code');
    await page.getByLabel('หมวดหมู่',{exact:true}).last().fill('พัฒนา');
    await page.getByLabel('คำอธิบาย',{exact:true}).fill('Review changes for correctness');
    await page.getByLabel('คำสั่งใน SKILL.md',{exact:true}).fill('---\nname: review-code\ndescription: Review code safely\n---\n\n# Review\nCheck correctness.');
    await page.getByRole('button',{name:'บันทึก Skill',exact:true}).click();
    await page.getByRole('button',{name:'Review code',exact:true}).waitFor();
    await page.getByRole('checkbox',{name:/เลือก Review code/}).check();
    await page.getByRole('button',{name:'บันทึกชุด Skill',exact:true}).click();
    await page.getByText('บันทึกชุด Skill แล้ว',{exact:true}).waitFor();
    await page.getByRole('searchbox',{name:'ค้นหา Skill'}).fill('absent');
    assert.equal(await page.getByRole('heading',{name:'ไม่พบ Skill ที่ค้นหา'}).count(),1);
    await page.getByRole('searchbox',{name:'ค้นหา Skill'}).fill('');
    const state=await page.evaluate(()=>window.skillHub.getState());
    assert.equal(state.skills.length,1);assert.equal(state.profiles[0].skillIds.length,1);
    const input=path.join(testRoot,'example'); await fs.mkdir(path.join(input,'references'),{recursive:true});
    await fs.writeFile(path.join(input,'SKILL.md'),'---\nname: imported-helper\ndescription: An imported helper\n---\n\n# Helper\nRead references.');
    await fs.writeFile(path.join(input,'references','guide.txt'),'Support content');
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},input);
    await page.getByRole('button',{name:'นำเข้าโฟลเดอร์',exact:true}).first().click();
    await page.getByRole('button',{name:'imported-helper',exact:true}).waitFor();
    await page.getByRole('checkbox',{name:/เลือก imported-helper/}).check();
    await page.getByRole('button',{name:'บันทึกชุด Skill',exact:true}).click();
    await page.getByText('บันทึกชุด Skill แล้ว',{exact:true}).waitFor();
    const out=path.join(testRoot,'export');await fs.mkdir(out);
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},out);
    await page.getByRole('button',{name:'ส่งออกชุด Skill',exact:true}).click();
    await page.getByText(/ส่งออก 2 Skill แล้ว:/).waitFor();
    const exports=await fs.readdir(out);assert.equal(exports.length,1);
    const manifest=JSON.parse(await fs.readFile(path.join(out,exports[0],'manifest.json'),'utf8'));
    assert.equal(manifest.skills.length,2);
    const imported=manifest.skills.find(s=>s.name==='imported-helper');
    assert.equal(await fs.readFile(path.join(out,exports[0],path.dirname(imported.path),'references','guide.txt'),'utf8'),'Support content');
    await page.getByRole('button',{name:/AI ของฉัน/}).click();
    assert.equal(await page.locator('.profile-card').count(),4);
    await page.getByRole('button',{name:'เพิ่มโปรไฟล์ AI',exact:true}).first().click();
    await page.getByLabel('ชื่อโปรไฟล์',{exact:true}).fill('ทีมเว็บไซต์');
    await page.getByRole('button',{name:'บันทึกโปรไฟล์',exact:true}).click();
    await page.getByRole('heading',{name:'ทีมเว็บไซต์',exact:true}).waitFor();
    await page.getByRole('button',{name:/คลัง Skill/}).click();
    await page.getByRole('button',{name:'Review code',exact:true}).click();
    assert.match(await page.locator('.markdown-preview').textContent(),/Check correctness/);
    await page.getByRole('button',{name:'ปิด',exact:true}).click();
    await page.getByText('พบ 1 Skill บนเครื่อง', {exact:true}).waitFor();
    await page.getByRole('button', {name:'ดู Skill บนเครื่อง', exact:true}).click();
    await page.getByRole('checkbox', {name:'นำเข้า autodetected-helper จาก Test AI', exact:true}).check();
    await page.getByRole('button', {name:'นำเข้าที่เลือก (1)', exact:true}).click();
    await page.getByRole('button', {name:'autodetected-helper', exact:true}).waitFor();
    await page.getByRole('button', {name:'ดู Skill บนเครื่อง', exact:true}).click();
    const importedBox = page.getByRole('checkbox', {name:'นำเข้า autodetected-helper จาก Test AI', exact:true});
    assert.equal(await importedBox.isDisabled(), true);
    await page.getByRole('button', {name:'ค้นหาใหม่', exact:true}).click();
    await page.getByText('นำเข้าแล้ว', {exact:true}).waitFor();
    assert.equal((await page.evaluate(()=>window.skillHub.getState())).skills.length, 3);
    await page.getByRole('button', {name:'ปิด', exact:true}).click();
    const repoFolder = path.join(testRoot, 'local-repo');
    await fs.mkdir(path.join(repoFolder, 'skills', 'repo-helper', 'references'), {recursive:true});
    await fs.writeFile(path.join(repoFolder, 'skills', 'repo-helper', 'SKILL.md'), '---\nname: repo-helper\ndescription: A repo installation helper\n---\n\n# Repo helper\nCheck the source.');
    await fs.writeFile(path.join(repoFolder, 'skills', 'repo-helper', 'references', 'guide.txt'), 'Repository supporting file');
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},repoFolder);
    await page.getByRole('button', {name:'นำเข้าคลังโค้ด', exact:true}).click();
    await page.getByRole('button', {name:'เลือกโฟลเดอร์คลังโค้ด', exact:true}).click();
    await page.getByRole('checkbox', {name:'นำเข้า repo-helper จากคลังโค้ด', exact:true}).waitFor();
    await page.getByRole('button', {name:'นำเข้าที่เลือก (1)', exact:true}).click();
    await page.getByRole('heading', {name:'นำเข้าแล้ว 1 Skill', exact:true}).waitFor();
    await page.getByRole('button', {name:'ปิด', exact:true}).click();
    await page.getByRole('checkbox', {name:/เลือก repo-helper ให้/}).check();
    await page.getByRole('button', {name:'บันทึกชุด Skill', exact:true}).click();
    await page.getByText('บันทึกชุด Skill แล้ว', {exact:true}).waitFor();
    const targets = await page.evaluate(()=>window.skillHub.detectTargets());
    assert.equal(targets.find(t=>t.id==='codex').detected,true);
    assert.equal(targets.find(t=>t.id==='claude').detected,true);
    assert.equal(targets.find(t=>t.id==='chatgpt').supported,false);
    await page.getByRole('button', {name:'ติดตั้งให้ AI', exact:true}).click();
    await page.getByRole('checkbox', {name:'ติดตั้งให้ Claude Code', exact:true}).waitFor();
    for (const target of targets.filter(t=>t.detected&&t.supported&&!['codex','claude'].includes(t.id))) {
      await page.getByRole('checkbox', {name:`ติดตั้งให้ ${target.name}`, exact:true}).uncheck();
    }
    await page.getByRole('button', {name:'ตรวจแผนการติดตั้ง', exact:true}).click();
    await page.getByRole('region', {name:'แผนการติดตั้ง', exact:true}).waitFor();
    assert.equal(await page.locator('.plan-new').count(),6);
    await page.getByRole('button', {name:'ติดตั้งให้ AI ที่เลือกทั้งหมด', exact:true}).click();
    await page.getByRole('heading', {name:'ติดตั้งแล้ว 6 รายการ', exact:true}).waitFor();
    for (const providerFolder of ['.agents','.claude']) {
      const folder=path.join(fixtureHome,providerFolder,'skills','repo-helper');
      assert.match(await fs.readFile(path.join(folder,'SKILL.md'),'utf8'),/A repo installation helper/);
      assert.equal(await fs.readFile(path.join(folder,'references','guide.txt'),'utf8'),'Repository supporting file');
    }
    await page.getByRole('button', {name:'ปิด', exact:true}).click();
    await page.getByRole('button', {name:'ติดตั้งให้ AI', exact:true}).click();
    await page.getByRole('checkbox', {name:'ติดตั้งให้ Claude Code', exact:true}).waitFor();
    for (const target of targets.filter(t=>t.detected&&t.supported&&!['codex','claude'].includes(t.id))) {
      await page.getByRole('checkbox', {name:`ติดตั้งให้ ${target.name}`, exact:true}).uncheck();
    }
    await page.getByRole('button', {name:'ตรวจแผนการติดตั้ง', exact:true}).click();
    await page.getByText('ไฟล์ปลายทางตรงกับชุดนี้แล้ว ไม่ต้องติดตั้งซ้ำ', {exact:true}).waitFor();
    assert.equal(await page.locator('.plan-unchanged').count(),6);
    await page.getByRole('button', {name:'ปิด', exact:true}).click();
    for(const width of [1380,1024,860]){
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Overflow at ${width}`);
    }
    await page.setViewportSize({width:1380,height:900});
    await page.screenshot({path:path.join(root,'screenshot.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: real Electron UI library/discovery/repository import/installation into two isolated AI homes/support files/unchanged no-op; no JS errors or desktop overflow.');
    console.log('Test data: '+testRoot);
  } finally {
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.destroy())).catch(()=>{});
    await app.close().catch(()=>{});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
