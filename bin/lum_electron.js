#!/usr/bin/env node
// LICENSE_CODE ZON ISC
'use strict'; /*jslint node:true, esnext:true*/
const electron = require('electron');
const child_process = require('child_process');
const app = electron.app;
const dialog = electron.dialog;
const opn = require('opn');
let _info_bkp = console.info;
console.info = function(){};
const auto_updater = require('electron-updater').autoUpdater;
console.info = _info_bkp;
const etask = require('../util/etask.js');
const zerr = require('../util/zerr.js');
const Manager = require('../lib/manager.js');
const tasklist = require('tasklist');
const taskkill = require('taskkill');
const pkg = require('../package.json');
const E = module.exports;

let manager, upgrade_available, can_upgrade;

const show_message = opt=>etask(function*(){
    let [res] = yield etask.cb_apply({ret_a: true}, dialog, '.showMessageBox',
        [opt]);
    return res;
});
const mgr_err = msg=>{
    if (manager && manager.log)
        manager.log.error(msg);
    else
        console.log(msg);
};

// XXX vladislavl: need refactor restart themself - electron does not support
// fork child other path js process run
const restart = ()=>{
    const child = child_process.spawn(process.execPath, process.argv.slice(1),
        {detached: true,windowsHide:false, stdio: ['inherit', 'inherit', 'inherit', 'ipc']});
    // wait until child re-open stdio
    child.on('message', msg=>{
        if (!msg || msg.cmd!='lpm_restart_init')
            return;
        child.unref();
        app.quit();
    });
};

let upgrade = ver=>etask(function*(){
    if (!can_upgrade)
    {
        let res = yield show_message({type: 'info', title: 'Luminati update',
            message: (ver ? `Luminati version ${ver}` : 'Luminati update')
            +' will be installed on exit',
            buttons: ['Install on exit', 'Install now']});
        if (!res)
            return void console.log('Update postponed until exit');
    }
    console.log('Starting upgrade');
    auto_updater.quitAndInstall();
});

auto_updater.allowDowngrade = true;
auto_updater.autoDownload = false;
auto_updater.on('error', ()=>{});

auto_updater.on('update-available', e=>etask(function*(){
    const changelog_url = 'https://github.com/luminati-io/luminati-proxy/blob/'
    +'master/CHANGELOG.md';
    const update_msg = `Update version ${e.version} is available. Full list of`
    +` changes is available here: ${changelog_url}`;
    console.log(update_msg);
    if (!can_upgrade)
    {
        let res = yield show_message({type: 'info',
            title: `Luminati update ${e.version} is available`,
            message: 'Luminati version '+e.version
            +' is available, would you like to download it?',
            buttons: ['No', 'Yes']});
        if (!res)
            return void console.log('Will not download update');
    }
    console.log(`Downloading version ${e.version}`);
    auto_updater.downloadUpdate();
}));

auto_updater.on('update-downloaded', e=>{
    console.log('Update downloaded');
    upgrade_available = true;
    upgrade(e.version);
});

const check_conflicts = ()=>etask(function*(){
    let tasks;
    try { tasks = yield tasklist(); }
    catch(e){ process.exit(); }
    tasks = tasks.filter(t=>t.imageName.includes('Allproxy Manager') &&
        t.pid!=process.pid);
    if (tasks.length<=2)
        return;
    const res = dialog.showMessageBox({
        type: 'warning',
        title: 'Address in use',
        message: `LPM is already running (${tasks[0].pid})\n`
            +'Click OK to stopping the '
            +'offending processes or Cancel to close LPM.\n\n'
            +'Suspected processes:\n'
            +'PID\t Image Name\t Session Name\t Mem Usage\n'
            +tasks.map(t=>`${t.pid}\t ${t.imageName}\t ${t.sessionName}\t `
                +`${t.memUsage}`).join('\n'),
        buttons: ['Ok', 'Cancel'],
    });
    if (res)
        return app.exit();
    try {
        yield taskkill(tasks.map(t=>t.pid), {tree: true, force: true});
    } catch(e){
        dialog.showMessageBox({
            type: 'warning',
            title: 'Failed stopping processes',
            message: 'Failed stopping processes. Restart Luminati Proxy '
                +'Manager as administrator or stop the processes manually '
                +'and then restart.\n\n'+e,
            buttons: ['Ok'],
        });
        process.exit();
    }
    restart();
});

const _run = argv=>etask(function*(){
    zerr.notice('Running Allproxy Master v%s, PID: %s', pkg.version,
        process.pid);
    yield check_conflicts();
    if (process.send)
        process.send({cmd: 'lpm_restart_init'});
    manager = new Manager(argv);
    auto_updater.logger = manager.log;
    setTimeout(()=>auto_updater.checkForUpdates(), 15000);
    manager.on('www_ready', url=>{
        opn(url);
    })
    .on('upgrade', cb=>{
        can_upgrade = true;
        if (upgrade_available)
            upgrade();
        else
            auto_updater.checkForUpdates();
    })
    .on('stop', ()=>{
        process.exit();
    })
    .on('error', (e, fatal)=>{
        let e_msg = e.raw ? e.message : 'Unhandled error: '+e;
        let handle_fatal = ()=>{
            if (fatal)
            {
                mgr_err(e_msg);
                process.exit();
            }
        };
        handle_fatal();
    })
    .on('config_changed', etask.fn(function*(zone_autoupdate){
        // XXX krzysztof: probably zone_autoupdate is not used anymore-cleanup
        yield manager.stop('config change', true, true);
        setTimeout(()=>_run(argv, zone_autoupdate && zone_autoupdate.prev ? {
            warnings: [`Your default zone has been automatically changed from `
                +`'${zone_autoupdate.prev}' to '${zone_autoupdate.zone}'.`],
        } : {}));
    }));
    manager.start();
});

let quit = err=>{
    if (err)
    {
        if (!manager)
            zerr.perr(err);
        mgr_err('uncaught exception '+zerr.e2s(err));
    }
    app.quit();
};

E.run = argv=>{
    app.on('ready-to-show', ()=>_run(
        app.show()
    ));
    app.on('ready', ()=>_run(argv));
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
    process.on('uncaughtException', quit);
};
