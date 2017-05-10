var Nora_Hal = require('./nora-hal.js'),
    _ = require('busyman'),
    util = require('util'),
    msgHandler = require('./components/msgHandler.js'),
    aesCmac = require('node-aes-cmac').aesCmac,
    CNST = require('./constants.json'),
    crypto = require('crypto'),
    EventEmitter = require('events').EventEmitter,
    nutils = require('./components/nutils.js'),
    lwm2mCodec = require('lwm2m-codec'),
    Q = require('q');

var hal = new Nora_Hal();

function NoraEd(config, so, devAttrs, nora) {
    var self = this,
        propUnwritable = { writable: false, enumerable: false, configurable: false };
    hal.config(config);
    this._nora = nora;
    // [TODO] class option?
    // display LoRaWAN connection status
    this._connectedStatus = 'unknown';
    this.status = 'offline';
    this.registered = false;
    this._retryTime = 20;
    this.count = null;
    // this.devAddr = null;
    // this.appKey = null;
    this.rxDelay = null;
    this.dlSettings = null;
    this.cfList = null;

    // Device Infomation
    Object.defineProperty(this, 'info', _.assign({
        value: {
            appEUI: null,
            devEUI: null,
            devNonce: null,
            appNonce: null,
            netId: null,
            devAddr: null,
            appKey: null,
            appSKey:null,
            nwkSKey:null,
            _nwkId: null,
            _nwkAddr: null
        }
    }, propUnwritable));

    this.so = so;
    this.lifetime = devAttrs.lifetime || 86400;
    this.version = devAttrs.version || '1.0.2';
    this.objList = [];


    hal.on('data', function (data) {
        // console.log();
        // [TODO] receive downlink message
        msgHandler._msgDispatch(self, nutils.parser(data));
    });

    nora._hal.on('data:server:tx', function (data) {
        console.log('nora end-device got server data');
        // console.log(data);
        // [TODO] receive downlink message
        msgHandler._msgDispatch(self, nutils.parser(data)).then(function (data) {
            console.log('dispatchEvent data');
            // console.log(data);
            msgHandler.dispatchEvent(self, data);
        });
    });
}

util.inherits(NoraEd, EventEmitter);

NoraEd.prototype.register = function (callback) {
    var self = this,
        deferred = Q.defer(),
        regMsgArray = [],
        regMsgBuf,
        regStringData,
        mic,
        registerData = {
            lifetime: null,
            version: null,
            objList: null
        };

    if (this._connectedStatus !== 'connected')
        deferred.reject('Device does not connect to LoRaWAN yet.');
    else {
        return Q.fcall(function () {
            // [TODO] send register msg
            // mhdr: 0x40. confirm data up
            regMsgArray.push(0x40);
            // devAddr
            for (var i = 0;i < 4;i += 1)
                regMsgArray.push((self.info.devAddr >> (8 * i)) & 0xff);
            // fCtrl: ADR, ADRACKReq, ACK, RFU, FOptsLen
            regMsgArray.push(0x00);
            // fCnt
            for (var i = 0;i < 2;i += 1)
                regMsgArray.push((self.count >> (8 * i)) & 0xff);
            // fPort: register: 0x06
            regMsgArray.push(0x06);
            // frmPayload
            // [TODO] need to be encrypted
            // data format. json format? TLV format?
            // 0: plain text
            // 1: opaque
            // 2: TLV
            // 3: JSON
            regMsgArray.push(0x30);
            // register data
            // [TODO] TLV format?
            // lwm2mCodec.encode('tlv, ');
            registerData.lifetime = self.lifetime;
            registerData.version = self.version;
            registerData.objList = self.so.objectList();

            regStringData = JSON.stringify(registerData);
            for (var i = 0;i < regStringData.length;i += 1)
                regMsgArray.push(regStringData[i].charCodeAt(0));
            // mic
            regMsgBuf = new Buffer(regMsgArray);
            mic = aesCmac(self.info.appKey, regMsgBuf, { returnAsBuffer: true });

            for (var i = 0;i < 4;i += 1)
                regMsgArray.push(mic[i]);

            regMsgBuf = new Buffer(regMsgArray);
            return regMsgBuf;
        }).then(function (data) {
            // fake data
            console.log('register data nora');
            // console.log(data.length);
            self._nora.cilentFakeTxData(data);
            // return hal.send(data);
        }).then(function () {
            var receiveFlag = false,
                result = { status: null, data: null };
            // [TODO] two receive windows?
            self.on('registerRsp', function () {
                console.log('registerRsp');

                receiveFlag = true;
            });

            setTimeout(function () {
                if (!receiveFlag) {
                    self.removeListener('registerRsp', function () {
                        // console.log('registerRsp timeout');
                    });
                    console.log('registerRsp timeout');
                    result.status = 408;
                    result.data = null;
                    // return result;
                    // return { status: 408, data: null }; // timeout
                    // deferred.resolve({ status: 408, data: null });  // timeout
                    deferred.resolve(result);  // timeout

                    return deferred.promise.nodeify(callback);
                }
            }, self.rxDelay * 1000);
        }).done();

        // return deferred.promise.nodeify(callback);
    }
};

NoraEd.prototype.getSmartObject = function () {
    return this.so;
};

NoraEd.prototype.deregister = function (callback) {
    var self = this,
        deferred = Q.defer(),
        deregMsgArray = [],
        deregMsgBuf,
        frmPayload = { devEUI: null },
        deregFrmPayload;

    if (!this.registered | !this._connectedStatus) {
        deferred.reject('Device does not connect/register to LoRaWAN yet.');
    } else {
        // [TODO] send message(deregister)
        return Q.fcall(function () {
            // [TODO] send register msg
            // mhdr: 0x40. confirm data up
            deregMsgArray.push(0x40);
            // devAddr
            for (var i = 0;i < 4;i += 1)
                deregMsgArray.push((self.info.devAddr >> (8 * i)) & 0xff);
            // fCtrl: ADR, ADRACKReq, ACK, RFU, FOptsLen
            deregMsgArray.push(0x00);
            // fCnt
            for (var i = 0;i < 2;i += 1)
                deregMsgArray.push((self.count >> (8 * i)) & 0xff);
            // fPort: deregister: 0x08
            deregMsgArray.push(0x08);
            // frmPayload
            // data format. json format?
            deregMsgArray.push(0x30);
            // deregister data
            frmPayload.devEUI = self.info.devEUI;
            deregFrmPayload = JSON.stringify(frmPayload);
            // [TODO] need to be encrypted
            // nuitls.frmPayloadcrypto(self, data);
            for (var i = 0;i < deregFrmPayload.length;i += 1)
                deregMsgArray.push(deregFrmPayload[i].charCodeAt(0));
            // mic
            deregMsgBuf = new Buffer(deregMsgArray);
            mic = aesCmac(self.info.appKey, deregMsgBuf, { returnAsBuffer: true });

            for (var i = 0;i < 4;i += 1)
                deregMsgArray.push(mic[i]);

            deregMsgBuf = new Buffer(deregMsgArray);
            return deregMsgBuf;
        }).then(function (data) {
            // fake data
            console.log('deregister data nora');
            // console.log(data);
            self._nora.cilentFakeTxData(data);
            
            // return hal.send(data);
        }).done(function () {
            // [TODO] two receive windows?
        });
    }

    return deferred.promise.nodeify(callback);
};

NoraEd.prototype._update = function (devAttrs, callback) {
    var self = this,
        deferred = Q.defer(),
        updateMsgArray = [],
        updateMsgBuf,
        frmPayload = { devEUI: null },
        updateFrmPayload;

    // Change of mac address and clientId at runtime will be ignored
    if (!_.isPlainObject(devAttrs))
        throw new TypeError('devAttrs should be an object.');

    if (!_.isFunction(callback))
        throw new TypeError('callback should be given and should be a function.');

    // [TODO] send message
    if (!this.registered | !this._connectedStatus) {
        deferred.reject('Device does not connect/register to LoRaWAN yet.');
    } else {
        // [TODO] send message(deregister)
        return Q.fcall(function () {
            // [TODO] send register msg
            // mhdr: 0x40. confirm data up
            updateMsgArray.push(0x40);
            // devAddr
            for (var i = 0;i < 4;i += 1)
                updateMsgArray.push((self.info.devAddr >> (8 * i)) & 0xff);
            // fCtrl: ADR, ADRACKReq, ACK, RFU, FOptsLen
            updateMsgArray.push(0x00);
            // fCnt
            for (var i = 0;i < 2;i += 1)
                updateMsgArray.push((self.count >> (8 * i)) & 0xff);
            // fPort: update: 0x07
            updateMsgArray.push(0x07);
            // frmPayload
            // data format. json format?
            updateMsgArray.push(0x30);
            // update data
            updateFrmPayload = JSON.stringify(devAttrs);
            // [TODO] need to be encrypted
            // nuitls.frmPayloadcrypto(self, data);
            for (var i = 0;i < updateFrmPayload.length;i += 1)
                updateMsgArray.push(updateFrmPayload[i].charCodeAt(0));
            // mic
            updateMsgBuf = new Buffer(updateMsgArray);
            mic = aesCmac(self.info.appKey, updateMsgBuf, { returnAsBuffer: true });

            for (var i = 0;i < 4;i += 1)
                updateMsgArray.push(mic[i]);

            updateMsgBuf = new Buffer(updateMsgArray);
            return updateMsgBuf;
        }).then(function (data) {
            // fake data
            console.log('update data nora');
            // console.log(data);
            self._nora.cilentFakeTxData(data);
            // return hal.send(data);
        }).done(function () {
            // [TODO] two receive windows?
        });
    }
};

NoraEd.prototype.update = function (attrs, callback) {
    if (!_.isPlainObject(attrs)) 
        throw new TypeError('attrs should be an object.');
    else if (!_.isFunction(callback))
        throw new TypeError('callback should be given and should be a function.');

    var self = this
        updateObj = {},
        objListInPlain,
        localStatus;

    _.forEach(attrs, function (val, key) {
        if (key === 'lifetime' && attrs.lifetime !== self.lifetime) {
            self.so.set('lwm2mServer', 0, 'lifetime', attrs.lifetime);
            self.lifetime = updateObj.lifetime = attrs.lifetime;
        } else if (key === 'version' && attrs.version !== self.version) {
            self.version = updateObj.version = attrs.version;
        } else {
            // [TODO] define RSP
            localStatus = RSP.badreq;
        }
    });

    if (localStatus && _.isFunction(callback)) {
        setImmediate(function () {
            callback(null, { status: localStatus });
        });
    } else {
        // [TODO] does it need to scheduled next update time?
        // self._lifeUpdate(true);     // schedule next update at lifetime
        this._update(updateObj, callback);
    }

    return this;
};

NoraEd.prototype.notify = function (data, callback) {
    if (!_.isPlainObject(data))
        throw new TypeError('data should be an object.');

    if (!_.isFunction(callback))
        throw new TypeError('callback should be given and should be a function.');

    var self = this,
        deferred = Q.defer(),
        notifyMsgArray = [],
        notifyMsgBuf,
        frmPayload = { devEUI: null },
        notifyFrmPayload;

    if (!this.registered | !this._connectedStatus) {
        deferred.reject('Device does not connect/register to LoRaWAN yet.');
    } else {
        // [TODO] send message(deregister)
        return Q.fcall(function () {
            // [TODO] send register msg
            // mhdr: 0x40. confirm data up
            notifyMsgArray.push(0x40);
            // devAddr
            for (var i = 0;i < 4;i += 1)
                notifyMsgArray.push((self.info.devAddr >> (8 * i)) & 0xff);
            // fCtrl: ADR, ADRACKReq, ACK, RFU, FOptsLen
            notifyMsgArray.push(0x00);
            // fCnt
            for (var i = 0;i < 2;i += 1)
                notifyMsgArray.push((self.count >> (8 * i)) & 0xff);
            // fPort: deregister: 0x12
            notifyMsgArray.push(0x12);
            // frmPayload
            // data format. json format? TLV?
            notifyMsgArray.push(0x30);
            // notidy data
            // oid, iid, rids, data
            notifyFrmPayload = JSON.stringify(data);
            // [TODO] need to be encrypted
            // nuitls.frmPayloadcrypto(self, data);
            for (var i = 0;i < notifyFrmPayload.length;i += 1)
                notifyMsgArray.push(notifyFrmPayload[i].charCodeAt(0));
            // mic
            notifyMsgBuf = new Buffer(notifyMsgArray);
            mic = aesCmac(self.info.appKey, notifyMsgBuf, { returnAsBuffer: true });

            for (var i = 0;i < 4;i += 1)
                notifyMsgArray.push(mic[i]);

            notifyMsgBuf = new Buffer(notifyMsgArray);
            return notifyMsgBuf;
        }).then(function (data) {
            // fake data
            console.log('deregister data nora');
            // console.log(data);
            self._nora.cilentFakeTxData(data);
            // return hal.send(data);
        }).done(function () {
            // [TODO] two receive windows?
        });
    }

    return deferred.promise.nodeify(callback);
};

// NoraEd.prototype.sendMessage = function (devAddr, confirm, ack, pending, cmdId, payload, callback) {
//     var self = this;
//     // mhdr
//     return Q.fcall(function () {
//         var buf = [];
//         // mhdr
//         if (confirm)
//             buf.push(0xa0);
//         else
//             buf.push(0x60);
//         return buf;
//     }).then(function (buf) {
//         // devAddr
//         for (var i = 0;i < 4;i += 1)
//             buf.push((devAddr >> (8 * i)) & 0xff);
//         return buf;
//     }).then(function (buf) {
//         // fctrl
//         ack = ack ? 1 : 0;
//         pending = pending ? 1 : 0;
//         buf.push((ack << 5) | (pending << 4));
//     }).then(function (buf) {
//         // count
//         buf.push(self.count & 0xff);
//         buf.push((self.count >> 8) & 0xff);
//     }).then(function (buf) {
//         // fport
//         buf.push(cmdId);
//     }).then(function (buf) {
//         // frmPayload
//         // encrypted payload
//         payload = nutils.frmPayloadcrypto(self, payload, self.appSKey);
//         for (var i = 0;i < payload.length;i += 1)
//             buf(payload[i]);
//     }).then(function (buf) {
//         // generate mic
//         buf = nutils.addMic(self, buf, 1);
//         return buf;
//     }).then(function () {
//         // [TODO] according to class A, B, C
//         setTimeout(function () {
//             return hal.send(buf);
//         }, self.rxDelay * 1000);
//     }).nodeify(callback);
// };

NoraEd.prototype._start = function () {
    hal.start().then(function () {
        hal.idle();
    });
};

NoraEd.prototype.activate = function (joinWay, config, callback) {
    var self = this,
        deferred = Q.defer();

    if (!_.isString(joinWay))
        throw new TypeError('joinWay should be a String.');

    if (joinWay !== 'OTAA' & joinWay !== 'ABP')
        throw new Error('joinWay should be OTAA or ABP.');

    // OTAA config: appEUI, devEUI, devNonce, appKey. After join: appNonce, netId, devAddr, rx1DROffset, rx2DR, rxDelay, cfList
    // ABP config: devAddr, nwkSKey, appSKey. Other info: netId, rx1DROffset, rx2DR, rxDelay, cfList
    // [TODO] search if there have the same devEUI/devAddr exist
    if (joinWay === 'ABP') {
        if (config.devAddr === undefined | config.nwkSKey === undefined | config.appSKey === undefined) {
            throw new TypeError('devAddr, nwkSKey or appSKey can not be undefined, please assign value to those parameters.');
            // deferred.reject('devAddr, nwkSKey or appSKey can not be undefined, please assign value to those parameters.');
        } else if (!_.isString(config.nwkSKey) | !_.isString(config.appSKey)) {
            throw new TypeError('nwkSKey and appSKey should be a String.');
        } else {  // push ABP config
            this.info.devAddr = parseInt(config.devAddr);
            // nwkSKey & appSKey should be ASCII
            this.info.nwkSKey = config.nwkSKey;
            this.info.appSKey = config.appSKey;
            this._connectedStatus = 'connected';
        }
    } else if (joinWay === 'OTAA') {
        if (config.appEUI === undefined | config.devEUI === undefined | config.devNonce === undefined | config.appKey === undefined) {
            throw new TypeError('appEUI, devEUI, devNonce and appKey can not be undefined, please assign value to those parameters.');
            // deferred.reject('appEUI, devEUI, devNonce or appKey can not be undefined, please assign value to those parameters.');
        } else if (!_.isString(config.appEUI) | !_.isString(config.devEUI) | !_.isString(config.appKey)) {
            throw new TypeError('appEUI, devEUI and appKey should be a String.');
        } else {  // push OTAA conifg
            this.info.appEUI = config.appEUI;
            this.info.devEUI = config.devEUI;
            // this.info.netId = config.netId;
            // this.info.devAddr = config.devAddr;
            this.info.devNonce = config.devNonce;
            this.info.appKey = config.appKey;
            // [TODO] generated nwkSKey & appSKey
            this.info.appSKey = nutils.createSKey('appSKey', self);
            this.info.nwkSKey = nutils.createSKey('nwkSKey', self);

            // [TODO] send joinRequest & receive joinAccept
            setTimeout(function () {
                self._joinRequest();
            }, 500);
            // [TODO] how many times need to be tried?
            // setInterval(function () {
            //     setTimeout(function () {
            //         // [TODO] device turn to receive mode
            //     }, this._rxDelay * 1000);
            //     self._joinRequest().then(function () {
            //         // [TODO] device turn to sleep mode
            //     });
            // }, this._retryTime * 1000);
            
            // [TODO] repeat to send joinRequest until get joinAccept
        }
    }

    return deferred.promise.nodeify(callback);
};

NoraEd.prototype._joinRequest = function (callback) {
    var deferred = Q.defer(),
        mhdr,
        joinReqArray = [],
        joinReqBuf,
        data,
        mic,
        appEUIStr = [],
        devEUIStr = [];

    if (!_.isString(this.info.appKey))
        throw new TypeError('appKeyt must be a string');
    if (!this.info.appEUI | !this.info.devEUI | !this.info.devNonce | !this.info.appKey)
        throw new Error('appEUI, devEUI, devNonce or appKey can not be undefined.');

    // data: mhdr, appEUI, devEUI, devNonce, mic
    // mhdr
    // this.info.appKey = new Buffer(this.info.appKey, 'hex');
    mhdr = 0 | (0 << 2) | (CNST.JOINREQUEST << 5);
    joinReqArray.push(mhdr);
    // appEUI ,devEUI
    // [TODO] if input 0x0005648226, is not complete devEUI or appEUI string?
    appEUIStr[1] = this.info.appEUI.slice(0, 10);
    appEUIStr[0] = this.info.appEUI.slice(10, 18);
    devEUIStr[1] = this.info.devEUI.slice(0, 10);
    devEUIStr[0] = this.info.devEUI.slice(10, 18);
    if (!appEUIStr[0])
        appEUIStr[0] = '0x00'
    else
        appEUIStr[0] = '0x' + appEUIStr[0];
    if (!devEUIStr[0])
        devEUIStr[0] = '0x00'
    else
        devEUIStr[0] = '0x' + devEUIStr[0];

    for (var i = 0;i < 4;i += 1)
        joinReqArray.push(((parseInt(appEUIStr[0])) >> (i * 8)) & 0xff);
    for (var i = 0;i < 4;i += 1)
        joinReqArray.push(((parseInt(appEUIStr[1])) >> (i * 8)) & 0xff);

    for (var i = 0;i < 4;i += 1)
        joinReqArray.push(((parseInt(devEUIStr[0])) >> (i * 8)) & 0xff);
    for (var i = 0;i < 4;i += 1)
        joinReqArray.push(((parseInt(devEUIStr[1])) >> (i * 8)) & 0xff);
    // devNonce
    joinReqArray.push(this.info.devNonce & 0xff);
    joinReqArray.push((this.info.devNonce >> 8) & 0xff);
    // Generate MIC
    // cmac = aes128_cmac(AppKey, MHDR | AppEUI | DevEUI | DevNonce
    // MIC = cmac[0..3]
    joinReqBuf = new Buffer(joinReqArray);

    mic = aesCmac(this.info.appKey, joinReqBuf, { returnAsBuffer: true });
    for (var i = 0;i < 4;i += 1)
        joinReqArray.push(mic[0]);

    data = new Buffer(joinReqArray);

    // fake data
    // console.log('noraED send joinRequest data');
    // console.log(data);
    this._nora.cilentFakeTxData(data);

    // return hal.send(data).nodeify(callback);
};

// NoraEd.prototype.connect = function () {};

// NoraEd.prototype.connect = function () {};

module.exports = NoraEd;