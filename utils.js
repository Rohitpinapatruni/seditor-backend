const Y = require("yjs");
const syncProtocol = require("y-protocols/sync");
const awarenessProtocol = require("y-protocols/awareness");
const encoding = require("lib0/encoding");
const decoding = require("lib0/decoding");
const map = require("lib0/map");

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const wsReadyStateClosing = 2; // eslint-disable-line
const wsReadyStateClosed = 3; // eslint-disable-line

// disable gc when using snapshots!
const gcEnabled = process.env.GC !== "false" && process.env.GC !== "0";
const persistenceDir = process.env.YPERSISTENCE;

/**
 * @type {Map<string,WSSharedDoc>}
 */
const docs = new Map();

const messageSync = 0;
const messageAwareness = 1;
// const messageAuth = 2

/**
 * @param {Uint8Array} update
 * @param {any} origin
 * @param {WSSharedDoc} doc
 */
const updateHandler = (update, origin, doc) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    doc.conns.forEach((_, conn) => send(doc, conn, message));
};

class WSSharedDoc extends Y.Doc {
    /**
     * @param {string} name
     */
    constructor(name) {
        super({ gc: gcEnabled });
        this.name = name;
        /**
         * @type {Map<Object, Set<number>>}
         */
        this.conns = new Map();
        /**
         * @type {awarenessProtocol.Awareness}
         */
        this.awareness = new awarenessProtocol.Awareness(this);
        this.awareness.setLocalState(null);
        /**
         * @param {any} changed
         * @param {any} origin
         */
        const awarenessChangeHandler = ({ added, updated, removed }, origin) => {
            const changedClients = added.concat(updated, removed);
            const connControlledIDs = /** @type {Map<Object, Set<number>>} */ (
                this.conns
            );
            if (origin !== null) {
                const connControlledIDs = /** @type {Map<Object, Set<number>>} */ (
                    this.conns
                );
                added.forEach((clientID) => {
                    if (!connControlledIDs.has(origin)) {
                        connControlledIDs.set(origin, new Set());
                    }
          /** @type {Set<number>} */ (connControlledIDs.get(origin)).add(
                        clientID
                    );
                });
                removed.forEach((clientID) => {
                    if (connControlledIDs.has(origin)) {
                        const controlledIDs = /** @type {Set<number>} */ (
                            connControlledIDs.get(origin)
                        );
                        controlledIDs.delete(clientID);
                        if (controlledIDs.size === 0) {
                            connControlledIDs.delete(origin);
                        }
                    }
                });
            }
            // broadcast awareness update
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(
                encoder,
                awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
            );
            const buff = encoding.toUint8Array(encoder);
            this.conns.forEach((_, c) => {
                send(this, c, buff);
            });
        };
        this.awareness.on("update", awarenessChangeHandler);
        this.on("update", updateHandler);
    }
}

/**
 * Gets a Y.Doc by name, creating it if it doesn't exist.
 * @param {string} docname
 * @param {boolean} [gc=true]
 * @return {WSSharedDoc}
 */
const getYDoc = (docname, gc = true) => {
    return map.setIfUndefined(docs, docname, () => {
        const doc = new WSSharedDoc(docname);
        doc.gc = gc;
        if (persistenceDir !== null) {
            // Persistence logic would go here
        }
        return doc;
    });
};

/**
 * @param {any} conn
 * @param {any} req
 * @param {any} [opts]
 */
const setupWSConnection = (conn, req, { docName = req.url.slice(1).split("?")[0], gc = true } = {}) => {
    conn.binaryType = "arraybuffer";
    // get doc, initialize if it does not exist yet
    const doc = getYDoc(docName, gc);
    doc.conns.set(conn, new Set());
    // listen and reply to events
    conn.on("message", /** @param {ArrayBuffer} message */(message) => {
        try {
            const encoder = encoding.createEncoder();
            const decoder = decoding.createDecoder(new Uint8Array(message));
            const messageType = decoding.readVarUint(decoder);
            switch (messageType) {
                case messageSync:
                    encoding.writeVarUint(encoder, messageSync);
                    syncProtocol.readSyncMessage(decoder, encoder, doc, null);
                    if (encoding.length(encoder) > 1) {
                        send(doc, conn, encoding.toUint8Array(encoder));
                    }
                    break;
                case messageAwareness:
                    awarenessProtocol.applyAwarenessUpdate(
                        doc.awareness,
                        decoding.readVarUint8Array(decoder),
                        conn
                    );
                    break;
            }
        } catch (err) {
            console.error(err);
            doc.emit("error", [err]);
        }
    });

    // Check if connection is still alive
    let pongReceived = true;
    const pingInterval = setInterval(() => {
        if (!pongReceived) {
            if (doc.conns.has(conn)) {
                closeConn(doc, conn);
            }
            clearInterval(pingInterval);
        } else if (doc.conns.has(conn)) {
            pongReceived = false;
            try {
                conn.ping();
            } catch (e) {
                closeConn(doc, conn);
                clearInterval(pingInterval);
            }
        }
    }, 30000);

    conn.on("close", () => {
        closeConn(doc, conn);
        clearInterval(pingInterval);
    });
    conn.on("pong", () => {
        pongReceived = true;
    });
    // put the following in a variables in a block so the interval handlers don't keep in in
    // scope
    {
        // send sync step 1
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeSyncStep1(encoder, doc);
        send(doc, conn, encoding.toUint8Array(encoder));
        const awarenessStates = doc.awareness.getStates();
        if (awarenessStates.size > 0) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageAwareness);
            encoding.writeVarUint8Array(
                encoder,
                awarenessProtocol.encodeAwarenessUpdate(
                    doc.awareness,
                    Array.from(awarenessStates.keys())
                )
            );
            send(doc, conn, encoding.toUint8Array(encoder));
        }
    }
};

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 * @param {Uint8Array} m
 */
const send = (doc, conn, m) => {
    if (
        conn.readyState !== wsReadyStateConnecting &&
        conn.readyState !== wsReadyStateOpen
    ) {
        closeConn(doc, conn);
    }
    try {
        conn.send(m, (/** @param {any} err */ err) => {
            if (err != null) {
                closeConn(doc, conn);
            }
        });
    } catch (e) {
        closeConn(doc, conn);
    }
};

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const closeConn = (doc, conn) => {
    if (doc.conns.has(conn)) {
        /** @type {Set<number>} */
        // @ts-ignore
        const controlledIds = doc.conns.get(conn);
        doc.conns.delete(conn);
        awarenessProtocol.removeAwarenessStates(
            doc.awareness,
            Array.from(controlledIds),
            null
        );
        if (doc.conns.size === 0 && persistenceDir === null) {
            // if persisted, we probably want to keep the doc in memory
            // docs.delete(doc.name)
        }
    }
    conn.close();
};

module.exports = {
    setupWSConnection,
    docs,
};
