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
    catch (e) {
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
                    return Promise.resolve(true);
                case 'try-move-focus-from-closing-current-tab':
                    console.log("current tab closing");
                    let focusChanged = focusPrecedingChildTab(aMessage);
                    focusChanged.then((value) => console.log('Blocked TST Default Tab Focus: ' + value));
                    return Promise.resolve(focusChanged);
            }
            break;
    }
});



var windows = [];
const cacheLength = 5;

function getCachedWindow(windowId) {
    let window = windows.filter(window => window.id === windowId);
    if (window.length < 0) {
        return null;
    } else {
        return window[0];
    }
}
async function cacheActiveTab(windowId, removedTabId = null, addedTabId = null) {
    let window = getCachedWindow(windowId);
    if (!window) {
        return;
    }

    let previousWork = window.work;
    let result = new Promise(async (resolve, reject) => {
        try {
            let activeTab = await browser.tabs.query({ windowId: windowId, active: true });
            activeTab = activeTab[0];

            try {
                await previousWork;
            } catch (error) { }


            if (!window.ignore) {
                window.ignore = [];
            }
            if ((removedTabId || removedTabId === 0) && !window.ignore.includes(removedTabId)) {
                window.ignore.push(removedTabId);
            }
            if ((addedTabId || addedTabId === 0) && window.ignore.includes(addedTabId)) {
                window.ignore = window.ignore.filter(tabId => tabId !== addedTabId);
            }

            if (window.ignore.includes(activeTab.id)) {
                resolve();
                return;
            }

            if (!window.iii) {
                window.iii = 0;
            }

            if (!window.cache) {
                // console.log('first cached tab');
                window.cache = [activeTab];
                window.iii = 1;
            } else {
                let tabIndex = window.cache.map(tab => tab.id).indexOf(activeTab.id);
                if (tabIndex < 0) {
                    // console.log('new tab cached');
                    if (window.iii >= cacheLength) {
                        window.iii = 0;
                    }
                    window.cache.splice(window.iii, window.cache.length > window.iii ? 1 : 0, activeTab);
                    window.iii++;
                } else {
                    // console.log('cached tab updated');
                    window.cache[tabIndex] = activeTab;
                }
            }
            resolve();
        } catch (error) {
            console.log('Failed to cache active tab:\n' + error);
            reject(error);
        }
    });
    window.work = result;
    return result;
}

browser.tabs.onActivated.addListener((activeInfo) => {
    cacheActiveTab(activeInfo.windowId);
});
browser.tabs.onMoved.addListener((tabId, moveInfo) => {
    cacheActiveTab(moveInfo.windowId);
});

browser.tabs.onCreated.addListener((tab) => {
    cacheActiveTab(tab.windowId, null, tab.id);
});
browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    cacheActiveTab(removeInfo.windowId, tabId);
});

browser.tabs.onDetached.addListener((tabId, detachInfo) => {
    cacheActiveTab(detachInfo.oldWindowId, tabId);
});
browser.tabs.onAttached.addListener((tabId, attachInfo) => {
    cacheActiveTab(attachInfo.newWindowId, null, tabId);
});

browser.windows.onCreated.addListener((window) => {
    windows.push({
        id: window.id,
        info: window,
    });
    cacheActiveTab(window.id);
});
browser.windows.onRemoved.addListener((windowId) => {
    windows = windows.filter(window => window.id !== windowId);
});

browser.windows.getAll().then(value => {
    for (let window of value) {
        if (!getCachedWindow(window.id)) {
            windows.push({
                id: window.id,
                info: window,
            });
        }
    }
});



async function focusPrecedingChildTab(aMessage) {
    try {
        var closedTab = aMessage.tab;
        if (closedTab.children.length > 0) {
            console.log('Closed tab has children so focus on them.');
            return false;
        }

        // Get tab info:
        let realClosedTab = await browser.tabs.get(closedTab.id);
        let cachedWindow = getCachedWindow(realClosedTab.windowId);
        await cachedWindow.work;
        let closedNativeTab = cachedWindow.cache.filter(tab => tab.id === closedTab.id);

        activeNativeTab = await browser.tabs.query({
            windowId: realClosedTab.windowId,
            active: true,
        });
        activeNativeTab = activeNativeTab[0];

        // Use active tab's index if closed tab can't be found:
        if (closedNativeTab.length === 0) {
            console.log('Closed tab not cached. Using active tab instead.')
            closedNativeTab = activeNativeTab;
        }
        closedNativeTab = Array.isArray(closedNativeTab) ? closedNativeTab[0] : closedNativeTab;
        var index = closedNativeTab.index - 1;

        // Find previous tab:
        var getPreviousTab = async (windowId, index) => {
            tabs = await browser.tabs.query({
                windowId: windowId,
                index: index < 0 ? -index : index,
            });
            if (tabs.length > 0) {
                return tabs[0];
            } else {
                throw new Error('No tab at requested index.');
            }
        }
        var precedingNativeTab = await getPreviousTab(realClosedTab.windowId, index);
        if (precedingNativeTab.id === closedTab.id) {
            precedingNativeTab = await getPreviousTab(realClosedTab.windowId, --index);
        }

        if (closedTab.ancestorTabIds.includes(activeNativeTab.id)) {
            console.log('Current selected tab is parent tab to closed tab.');
            return true;
        }

        var tabIdToFocus = null;
        if (precedingNativeTab.index > 0) {
            var precedingTab = await browser.runtime.sendMessage(kTST_ID, {
                type: 'get-tree',
                tab: precedingNativeTab.id,
            });
            if (!precedingTab) {
                throw new Error('Failed to get TST tree info for focus target tab.');
            }

            tabIdToFocus = precedingTab.id;
            /*
            console.log(closedTab.ancestorTabIds);
            console.log(precedingTab.ancestorTabIds);
            /**/
            for (let iii = 0; iii < closedTab.ancestorTabIds.length || iii < precedingTab.ancestorTabIds.length; iii++) {
                var closedAncestorId = iii < closedTab.ancestorTabIds.length ? closedTab.ancestorTabIds[closedTab.ancestorTabIds.length - 1 - iii] : null;
                var precedingAncestorId = iii < precedingTab.ancestorTabIds.length ? precedingTab.ancestorTabIds[precedingTab.ancestorTabIds.length - 1 - iii] : null;

                tabIdToFocus = precedingAncestorId === null ? closedAncestorId : precedingAncestorId;
                if (closedAncestorId !== precedingAncestorId) {
                    console.log('wrong ancestors');
                    break;
                }
                if (iii >= closedTab.ancestorTabIds.length - 1 && iii >= precedingTab.ancestorTabIds.length - 1) {
                    tabIdToFocus = precedingTab.id;
                    break;
                }
            }
            if (tabIdToFocus === precedingTab.id && precedingTab.children.length > 0 && closedTab.ancestorTabIds.includes(tabIdToFocus)) {
                console.log('Preceding tab is parent to closed tab and still has children so focus on those.');
                tabIdToFocus = precedingTab.children[0].id;
            }
        } else {
            tabIdToFocus = precedingNativeTab.id;
        }

        if (tabIdToFocus === null) {
            throw new Error('Failed to find focus target tab.');
        }
        console.log("Focusing preceding tab");
        await browser.tabs.update(tabIdToFocus, { active: true });
    } catch (error) {
        console.log('Failed to focus on preceding tab:\n' + error);
        return false;
    }
    return true;
}
