'use strict';
const {VIRTUAL_WORKSPACE_ID, VIRTUAL_PANEL_ID} = require('../../shared/panels');

export function embedPanel(domElementId, ivisSandboxUrlBase, panelId, accessToken, optionsStr, callbacks) {
    const entityParams = {
        type: 'panel',
        id: panelId
    };

    const options = JSON.parse(optionsStr);

    embedEntity(domElementId, ivisSandboxUrlBase, entityParams, accessToken, options, callbacks);
}

/***
 *
 * @param domElementId
 * @param ivisSandboxUrlBase
 * @param templateId
 * @param config With possible properties: {name, description, params}
 * @param accessToken
 * @param options
 * @param callback
 * s
 */
export function embedTemplate(domElementId, ivisSandboxUrlBase, templateId, config, accessToken, optionsStr, callbacks) {
    const entityParams = {
        type: 'template',
        id: templateId,
        config: config
    };

    const options = JSON.parse(optionsStr);
    embedEntity(domElementId, ivisSandboxUrlBase, entityParams, accessToken, options, callbacks);
}

function restCall(method, url, data, callback) {
    const xhttp = new XMLHttpRequest();

    xhttp.onreadystatechange = () => {
        if (xhttp.readyState === 4 && xhttp.status === 200) {
            callback(xhttp.responseText ? JSON.parse(xhttp.responseText) : undefined);
        }
    };

    xhttp.open(method, url);
    xhttp.setRequestHeader("Content-type", "application/json");

    xhttp.send(data ? JSON.stringify(data) : null);
}

function embedEntity(domElementId, ivisSandboxUrlBase, entityParams, accessToken, options, callbacks) {

    function getAnonymousSandboxUrl(path) {
        return ivisSandboxUrlBase + 'anonymous/' + (path || '');
    }

    function getSandboxUrl(path) {
        return ivisSandboxUrlBase + accessToken + '/' + (path || '');
    }

    const {type, id} = entityParams;

    let refreshAccessTokenTimeout = null;
    const scheduleRefreshAccessToken = () => {
        refreshAccessTokenTimeout = setTimeout(() => {
            restCall('PUT', getSandboxUrl('rest/embedded-entity-renew-restricted-access-token'), {token: accessToken}, () => {
                scheduleRefreshAccessToken();
            });
        }, 30 * 1000);
    };
    scheduleRefreshAccessToken();


    restCall('GET', getSandboxUrl(`rest/${type}s/${id}`), null, entity => {
        let contentNodeIsLoaded = false;

        const sendMessage = (type, data) => {
            if (contentNodeIsLoaded) { // This is to avoid errors "common.js:45744 Failed to execute 'postMessage' on 'DOMWindow': The target origin provided ('http://localhost:8081') does not match the recipient window's origin ('http://localhost:3000')"
                contentNode.contentWindow.postMessage({type, data}, getSandboxUrl());
            }
        };

        const receiveMessage = evt => {
            const msg = evt.data;

            if (msg.type === 'initNeeded') {
                // It seems that sometime the message that the content node does not arrive. However if the content root notifies us, we just proceed
                contentNodeIsLoaded = true;

                let panel;
                if (type === 'template') {
                    panel = {
                        "id": VIRTUAL_PANEL_ID,
                        "name": entityParams.config.name || "",
                        "description": entityParams.config.description || "",
                        "workspace": VIRTUAL_WORKSPACE_ID,
                        "template": id,
                        "builtin_template": null,
                        "params": entityParams.config.params || {},
                        "namespace": entity.namespace,
                        "order": null,
                        "templateParams": entity.settings.params,
                        "templateElevatedAccess": entity.elevated_access,
                        "permissions": [
                            "edit",
                            "view"
                        ],
                        "orderBefore": 'none'
                    };
                } else {
                    panel = entity;
                }

                const contentProps = {
                    panel: panel
                };

                sendMessage('init', {accessToken, contentProps});

            } else if (msg.type === 'rpcRequest') {
                const method = msg.data.method;
                const params = msg.data.params;

                let ret;

                if (method === 'navigateTo') {
                    if (callbacks && callbacks.navigateTo) {
                        callbacks.navigateTo(params.path);
                    }
                }

                sendMessage('rpcResponse', {msgId: msg.data.msgId, ret});

            } else if (msg.type === 'clientHeight') {
                contentNode.height = msg.data;
            }
        };

        window.addEventListener('message', receiveMessage, false);

        let path = 'panel';

        if (options && options.theme) {
            path = `panel?theme=${options.theme}`;
        }

        const contentNode = document.createElement('iframe');
        contentNode.src = getAnonymousSandboxUrl(path);
        contentNode.style.border = '0px none';
        contentNode.style.width = '100%';
        contentNode.style.overflow = 'hidden';
        contentNode.onload = () => contentNodeIsLoaded = true;

        document.getElementById(domElementId).appendChild(contentNode);
    });
}
