const kTST_ID = 'treestyletab@piro.sakura.ne.jp';

async function registerToTST() {
    try {
    var success = await browser.runtime.sendMessage(kTST_ID, {
        type: 'register-self',
        name: self.id,
        listeningTypes: ['try-move-focus-from-closing-current-tab'],
    });
    console.log("TST registered");
    }
    catch(e) {
        console.log("TST is not available");
    }
}
registerToTST();

browser.runtime.onMessageExternal.addListener((aMessage, aSender) => {
    switch (aSender.id) {
      case kTST_ID:
        switch (aMessage.type) {
          case 'ready':
            registerToTST(); // passive registration for secondary (or after) startup
            console.log("TST registered");
            break;
          case 'try-move-focus-from-closing-current-tab':
            console.log("current tab closing");
            let focusChanged = focusPrecedingChildTab(aMessage);
            return Promise.resolve(focusChanged);
        }
        break;
    }
});

function focusPrecedingChildTab(aMessage) {
    browser.runtime.sendMessage(kTST_ID, {
        type:     'focus',
        tab:      'previousSibling', // required, tabs.Tab.id or alias
        silently: false // optional, boolean (default=false)
    });
    console.log("focusing preceding tab");
    return true;
}