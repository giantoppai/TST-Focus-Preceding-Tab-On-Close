const kTST_ID = 'treestyletab@piro.sakura.ne.jp';

function delay(timeInMilliseconds) {
    return new Promise((resolve) => setTimeout(resolve, timeInMilliseconds));
}

async function registerToTST() {
    try {
        const success = await browser.runtime.sendMessage(kTST_ID, {
            type: 'register-self',
            name: self.id,
            listeningTypes: ['ready', 'try-move-focus-from-closing-current-tab', 'tree-attached', 'tree-detached'],
        });
        if (success) console.log("TST registered");
        return true;
    }
    catch (e) { }
    console.log("TST is not available");
    return false;
}
registerToTST();

let isTstTryFocusApiEnabled = false;

browser.runtime.onMessageExternal.addListener(function (aMessage, aSender) {
    switch (aSender.id) {
        case kTST_ID:
            switch (aMessage.type) {
                case 'ready': {
                    isTstTryFocusApiEnabled = false;    // TST might have been updated.
                    registerToTST(); // passive registration for secondary (or after) startup
                    console.log("TST registered");
                    return Promise.resolve(true);
                }
                case 'try-move-focus-from-closing-current-tab': {
                    // this API Event is obsolete and unavailable on TST 2.6.9 and later on Firefox 65 and newer versions
                    isTstTryFocusApiEnabled = true;

                    console.log("current tab closing");
                    let focusChanged = focusPrecedingChildTab(aMessage.tab);
                    focusChanged.then((value) => console.log('Blocked TST Default Tab Focus: ' + value));
                    return Promise.resolve(focusChanged);
                }
                case 'tree-attached': {
                    const { tab, parent } = aMessage;
                    handleTreeStructureChange([tab, parent]);
                } break;
                case 'tree-detached': {
                    const { tab, oldParent } = aMessage;
                    handleTreeStructureChange([tab, oldParent]);
                } break;
            }
            break;
    }
});

/**
 * If the closed tab has child tabs then we want those to be selected instead of the preceding tab. Therefore we should update the tree data for the active tab if it is changed.
 * 
 * Example use case where this has an affect:
 * 1. Install [Move unloaded tabs for Tree Style Tab](https://addons.mozilla.org/firefox/addon/move-unloaded-tabs-for-tst/).
 * 2. Activate a tab without children.
 * 3. Make the tab after the current tab a child of the current tab. (If the child tab is moved then the Firefox move event is triggered which will update cached info anyway)
 * 4. Close current tab.
 * 
 * Result without this function: The preceding tab is activated.
 * Result with this function: The child tab is activated.
 *
 * @param {Object[]} tabs Tabs that has changed tree structure.
 */
function handleTreeStructureChange(tabs) {
    if (isTstTryFocusApiEnabled) return;    // Tree data is provided from event message.
    if (!Array.isArray(tabs)) {
        tabs = [tabs];
    }
    const [aTab] = tabs;
    const windowCache = getCachedWindow(aTab.windowId);
    if (windowCache) {
        for (const tab of tabs) {
            if (windowCache.lastActiveTab.id === tab.id) {
                cacheActiveTab(aTab.windowId);
            }
        }
    }
}

/**
 * @typedef {Object} CachedWindowInfo
 * @property {number} Info.id The id of the window.
 * @property {Object} Info.info The `windows.Window` object with info about the windows properties.
 * @property {Array} Info.cache `tabs.Tab` objects for cached activate tabs in this window. There will only be one `tabs.Tab` object per tab id.
 * @property {number} Info.indexOfLastAddedTab The index in the cache of the tab that was most recently added.
 * @property {Object} Info.lastActiveTab The `tabs.Tab` object that was most recently cached as active.
 * @property {Promise<void>} Info.work A promise for the previous cache request. Used to ensure that the cache is updated in the right order.
 */
null;

/**
 * @type {Object.<string, CachedWindowInfo>}
 */
const windows = {};
const cacheLength = 5;

function getCachedWindow(windowId) {
    const window = windows[windowId];
    if (!window) return null;
    return window;
}
function getCachedWindowTabInChronologicalOrder(windowCache) {
    const tabs = windowCache.cache.slice();
    tabs.sort((a, b) => b.timeWhenTabLastBecameActive - a.timeWhenTabLastBecameActive);
    return tabs;
}
async function cacheActiveTab(windowId, removedTabId = null, addedTabId = null) {
    const window = getCachedWindow(windowId);
    if (!window) return;

    const previousWork = window.work;
    const result = (async () => {
        try {
            let activeTab;
            if (addedTabId !== null) {
                try {
                    activeTab = await browser.tabs.get(addedTabId);
                } catch (error) {
                    console.error('Failed to get info for the tab that should be active.\nError:\n', error);
                }
            }
            if (!activeTab) {
                for (let iii = 0; iii < 5; iii++) {
                    await delay(10);
                    [activeTab,] = await browser.tabs.query({ windowId: windowId, active: true });
                    if (
                        (
                            addedTabId === null ||
                            activeTab.id === addedTabId.id
                        ) &&
                        (
                            removedTabId === null ||
                            activeTab.id !== removedTabId.id
                        )
                    ) {
                        break;
                    }
                }
            }

            if (!isTstTryFocusApiEnabled) {
                let tstTabInfo;
                try {
                    tstTabInfo = await browser.runtime.sendMessage(kTST_ID, {
                        type: 'get-tree',
                        tab: activeTab.id,
                    });
                } catch (error) {
                    console.error('Failed to cache Tree Style Tab info for active tab.\nError', error);
                }
                if (tstTabInfo) activeTab.tstTab = tstTabInfo;

                activeTab.timeWhenTabLastBecameActive = Date.now();
            }

            try {
                await previousWork;
            } catch (error) { }


            if (!window.indexOfLastAddedTab) {
                window.indexOfLastAddedTab = 0;
            }

            if (!window.cache) {
                // console.log('first cached tab');
                window.cache = [activeTab];
            } else {
                let tabIndex = window.cache.map(tab => tab.id).indexOf(activeTab.id);
                if (tabIndex < 0) {
                    // console.log('new tab cached');
                    window.indexOfLastAddedTab++;
                    if (window.indexOfLastAddedTab >= cacheLength) {
                        window.indexOfLastAddedTab = 0;
                    }
                    window.cache.splice(window.indexOfLastAddedTab, window.cache.length > window.indexOfLastAddedTab ? 1 : 0, activeTab);
                } else {
                    // console.log('cached tab updated');
                    if (!isTstTryFocusApiEnabled) {
                        const previousCachedTab = window.cache[tabIndex];
                        if (window.lastActiveTab.id === activeTab.id) {
                            // Only update `timeWhenTabLastBecameActive` if the active tab was changed.                            
                            activeTab.timeWhenTabLastBecameActive = previousCachedTab.timeWhenTabLastBecameActive;
                        }
                        if (!activeTab.tstTab) {
                            activeTab.tstTab = previousCachedTab.tstTab;
                        }
                    }
                    window.cache[tabIndex] = activeTab;
                }
            }


            window.lastActiveTab = activeTab;
        } catch (error) {
            console.error('Failed to cache active tab:\n' + error);
        }
    })();
    window.work = result;
    return result;
}

browser.tabs.onActivated.addListener(function ({ windowId, previousTabId, tabId }) {
    cacheActiveTab(windowId, null, tabId);
});
browser.tabs.onMoved.addListener(function (tabId, moveInfo) {
    cacheActiveTab(moveInfo.windowId);
});

async function checkIfTabWasClosed(windowId, tabId) {
    if (!isTstTryFocusApiEnabled) {
        const windowCache = getCachedWindow(windowId);
        if (windowCache) {
            const now = Date.now();

            await windowCache.work;
            const tabs = getCachedWindowTabInChronologicalOrder(windowCache);
            for (const lastActiveTab of tabs) {
                // console.log('Check tab: ', lastActiveTab.id);

                if (lastActiveTab.id === tabId) {
                    focusPrecedingChildTab(lastActiveTab.tstTab);
                    return;
                }

                const timeSinceTabBecameActive = now - lastActiveTab.timeWhenTabLastBecameActive;
                if (timeSinceTabBecameActive > 250) {
                    // This tab's didn't become active recently => the previous cached active tab hasn't been active for at least that time => don't check any more cached tabs.
                    // console.log('tab wasn\'t active for: ', timeSinceCached, '\nTabId: ', lastActiveTab.id);
                    break;
                }
            }
        }
        // console.log('Tab was closed but it wasn\'t active.\nTabId ', tabId, '\nWindowId: ', windowId, '\nwindowCache: ', JSON.parse(JSON.stringify(windowCache)));
    }
}

browser.tabs.onCreated.addListener(function (tab) {
    cacheActiveTab(tab.windowId, null, tab.id);
});
browser.tabs.onRemoved.addListener(function (tabId, { isWindowClosing, windowId }) {
    if (isWindowClosing) return;
    checkIfTabWasClosed(windowId, tabId);
    cacheActiveTab(windowId, tabId);
});

browser.tabs.onDetached.addListener(function (tabId, detachInfo) {
    checkIfTabWasClosed(detachInfo.oldWindowId, tabId);
    cacheActiveTab(detachInfo.oldWindowId, tabId);
});
browser.tabs.onAttached.addListener(function (tabId, attachInfo) {
    cacheActiveTab(attachInfo.newWindowId, null, tabId);
});

browser.windows.onCreated.addListener(function (window) {
    if (!getCachedWindow(window.id)) {
        windows[window.id] = {
            id: window.id,
            info: window,
        };
        cacheActiveTab(window.id);
    }
});
browser.windows.onRemoved.addListener(function (windowId) {
    delete windows[windowId];
});

browser.windows.getAll().then(value => {
    for (const window of value) {
        if (!getCachedWindow(window.id)) {
            windows[window.id] = {
                id: window.id,
                info: window,
            };
            cacheActiveTab(window.id);
        }
    }
});



async function focusPrecedingChildTab(closedTab) {
    try {
        if (!closedTab) return;

        if (closedTab.children.length > 0) {
            console.log('Closed tab has children so focus on them.');
            return false;
        }

        // Get tab info:
        let cachedWindow = getCachedWindow(closedTab.windowId);
        await cachedWindow.work;
        let closedNativeTab = cachedWindow.cache.filter(tab => tab.id === closedTab.id);

        const [activeNativeTab,] = await browser.tabs.query({
            windowId: closedTab.windowId,
            active: true,
        });

        // Use active tab's index if closed tab can't be found:
        if (closedNativeTab.length === 0) {
            console.log('Closed tab not cached. Using active tab instead.');
            closedNativeTab = activeNativeTab;
        }
        closedNativeTab = Array.isArray(closedNativeTab) ? closedNativeTab[0] : closedNativeTab;
        let index = closedNativeTab.index - 1;

        // Find previous tab:
        const getPreviousTab = async (windowId, index) => {
            const tabs = await browser.tabs.query({
                windowId: windowId,
                index: index < 0 ? -index : index,
            });
            if (tabs.length > 0) {
                return tabs[0];
            } else {
                throw new Error('No tab at requested index.');
            }
        };
        var precedingNativeTab = await getPreviousTab(closedTab.windowId, index);
        if (precedingNativeTab.id === closedTab.id) {
            precedingNativeTab = await getPreviousTab(closedTab.windowId, --index);
        }

        if (closedTab.ancestorTabIds.includes(activeNativeTab.id)) {
            console.log('Current selected tab is parent tab to closed tab.');
            return true;
        }

        let tabIdToFocus = null;
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
        for (let iii = 0; iii < 1; iii++) {
            await browser.tabs.update(tabIdToFocus, { active: true });
            await delay(250);
        }
    } catch (error) {
        console.error('Failed to focus on preceding tab:\n' + error);
        return false;
    }
    return true;
}
