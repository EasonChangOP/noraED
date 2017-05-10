'use strict';

var _ = require('busyman'),
    // NoraEndDevice = require('./nora-end-device.js'),
    SmartObject = require('smartobject'),
    nutils = require('./nutils.js'),
    crypto = require('crypto'),
    aesCmac = require('node-aes-cmac').aesCmac,
    CNST = require('../constants.json'),
    Lwm2mCodec = require('lwm2m-codec'),
    lwm2mId = require('lwm2m-id'),
    Q = require('q');

var lwm2mEncode = Lwm2mCodec.encode,
    lwm2mDecode = Lwm2mCodec.decode;

if (!_.isFunction(Buffer.alloc)) {
    Buffer.alloc = function (size) {
        return new Buffer(size);
    };
}

if (!_.isFunction(Buffer.from)) {
    Buffer.from = function (array) {
        return new Buffer(array);
    };
}


var msgHandler = {};

msgHandler._registerHandler = function (nora, msg) {
    // [TODO] msg should not use json format, end-device will have lots of strings to tranmit
    // msg: { devAddr, lifetime, version, objList }
    var noraED = nora.find(msg.devAddr),
        so = noraED ? noraED.so : null,
        badAttr = false,
        acceptedAttrs = ['devAddr', 'lifetime', 'version', 'objList'];

    if (!noraED)
        return;

    // validate message
    _.forEach(msg, function (val, key) {            // unknown device attributes are not allowed
        if (!_.includes(acceptedAttrs, key))
            badAttr = true;
    });

    if (badAttr)
        return sendResponse(nora, 'register', msg.devAddr, 'BadRequest');

    // devAddr, confirm, ack, pending, cmdId, payload
    // Q.fcall(function () {
    msgHandler._objectDetailReq(noraED, noraED.info.devAddr, msg.objList).then(function (objs) {
        // [TODO] objList example:'/5/6/8'.objList transfer to smartObject
        // [TODO] read all resource?
        console.log('msg.objList');
        console.log(msg.objList);
        noraED._registered = true;
        // noraED.objList = msg.objList;
        noraED.version = msg.version;
        noraED._setStatus('online');
        return noraED.devBoxSave();
    }).then(function () {
        sendResponse(nora, 'register', msg.devAddr, 'Created');

        noraED.enableLifeChecker();

        setImmediate(function () {
            nora.emit('_registered', noraED);
            nora.emit('devIncoming', noraED);
        });
    }).fail(function (err) {
        noraED._registered = false;
        noraED._setStatus('offline');
        noraED.devBoxRemove().done();
        noraED.so = null;
        nora._endDeviceBox[msg.devAddr] = null;
        delete nora._endDeviceBox[msg.devAddr];
        sendResponse(nora, 'register', msg.devAddr, 'IntervalServerError');
    }).done();
}

msgHandler._updateHandler = function (nora, msg) {
    // msg: devAddr, lifetime , objList
    var so,
        noraED = nora.find(msg.devAddr),
        endDeviceData,
        endDeviceObjList,
        badAttr = false,
        acceptedAttrs = ['devAddr', 'lifetime', 'version', 'objList'];

    // validate message
    _.forEach(msg, function (val, key) {            // unknown device attributes are not allowed
        if (!_.includes(acceptedAttrs, key))
            badAttr = true;
    });

    if (!noraED || !noraED.so)
        return sendResponse(nora, 'update', msg.devAddr, 'NotFound');
    else if (badAttr)
        return sendResponse(nora, 'update', msg.devAddr, 'BadRequest');

    so = noraED.so;
    oidEDData = noraED.dump();
    oidObjList = noraED.objList;

    noraED.updateAttrs(msg).then(function (diff) {
        noraED.enableLifeChecker();

        if (_.has(diff, 'objList')) {
            qnode._registered = false;
            // kill old objects
            _.forEach(oidObjList, function (iids, oid) {
                var oidKey = nutils.oidKey(oid);
                so[oidKey] = null;
                delete so[oidKey];
            });

            return Q.fcall(function () {
                // [TODO] read all resource?
                _.forEach(msg.objList, function (obj) {
                    _.forEach(obj.data, function (rObjs, iid) {
                        so.init(obj.oid, iid, rObjs);
                    })
                });

                noraED.objList = msg.objList;
                return noraED.devBoxSave();
            }).then(function () {
                noraED._registered = true;

                setImmediate(function () {
                    nora.emit('updated', {devAddr: noraED.info.devAddr, data: diff});
                });
            }).fail(function (err) {
                // kill new objects
                _.forEach(oidObjList, function (iids, oid) {
                    var oidKey = nutils.oidKey(oid);
                    so[oidKey] = null;
                    delete so[oidKey];
                });

                // recover old Objs
                noraED.objList = oidObjList;
                // so.addObjects(oidEDData.so);
                _.forEach(oidEDData.so, function (iObjs, oid) {
                    _.forEach(iObjs, function (rObjs, iid) {
                        so.init(oid, iid, rObjs);
                    });
                });
                delete oidEDData.so;

                _.merge(noraED, oidEDData);
            }).done();
        } else {
            // [TODO]
        }
    }).fail(function (err) {

    }).done(function () {

    });
}

msgHandler._deregisterHandler = function (nora, msg) {
    // msg: devAddr
    var noraED = nora.find(msg.devAddr);

    if (!noraED)
        return sendResponse(nora, 'deregister', msg.devAddr, 'NotFound')

    noraED.disableLifeChecker();
    noraED._registered = false;
    noraED._setStatus('offline');

    noraED.devBoxRemove().done();
    noraED.so = null;
    delete noraED.so;
    nora.remove(msg.devAddr);

    sendResponse(nora, 'deregister', msg.devAddr, 'Deleted', function () {
        setImmediate(function () {
            nora.emit('deregister', msg.devAddr);
        });
    });
}

msgHandler._notifyHandler = function (nora, msg) {
    // msg: devAddr, oid, iid, rid, data
    var noraED = nora.find(msg.devAddr),
        iobj = (qnode && qnode.so) ? qnode.so.findObjectInstance(msg.oid, msg.iid) : undefined,
        resrc = (iobj && !_.isNil(msg.rid)) ? qnode.so.get(msg.oid, msg.iid, msg.rid) : undefined,
        rspStatus,
        targetPath;

    // validate message
    if (!noraED || !noraED.so)
        rspStatus = 'NotFound';
    else if (_.isNil(msg.oid) || _.isNil(msg.iid))
        rspStatus = 'BadRequest';
    else if (!iobj)
        rspStatus = 'NotFound';
    else if (_.isNil(msg.rid))      // data is object instance
        rspStatus = !_.isPlainObject(msg.data) ? 'BadRequest' : undefined;
    else if (_.isUndefined(resrc))  // data is resouece
        rspStatus = 'NotFound';

    if (rspStatus)
        sendResponse(nora, 'deregister', msg.devAddr, rspStatus);

    if (_.isNil(msg.rid)) {   // data is object instance
        var badResrc = false;
        targetPath = msg.oid + '/' + msg.iid;

        _.forEach(msg.data, function (val, rid) {
            var ridKey = nutils.ridKey(msg.oid, rid);
            badResrc = badResrc || _.isUndefined(qnode.so.get(msg.oid, msg.iid, rid));
            // replace rid with its string id
            delete msg.data[rid];
            msg.data[ridKey] = val;
        });
    } else {                        // data is an resource
        targetPath = msg.oid + '/' + msg.iid + '/' + msg.rid;
    }

    if (badResrc)
        return sendResponse(nora, 'notify', msg.devAddr, 'BadRequest');

    setImmediate(function () {
        nora.emit('devNotify', noraED, msg);
    });

    // [TODO]
    noraED.updateSoAndDevBox(targetPath, msg.data).then(function (diff) {
        msg.data = diff;
    });
}

msgHandler._readReqHandler = function (noraED, msg, callback) {
    // msg example?: '/3303', '/3303/0', '/3303/0/5700'
    // msg example: oid number: 2 bytes, iid string len: 1byte, iid string: x bytes, rid number: 2bytes
    var deferred = Q.defer(),
        i = 0,
        msgObj = {
            oid: null,
            iid: null,
            rid: null
        },
        status,
        path,
        so = noraED.getSmartObject();

    if (msg.length < 2)
        status = 400;   // BadRequest

    msgObj.oid = msg.readUInt16LE(i);
    i += 2;
    path = '/' + msgObj.oid;
    if (msg.length > 2) {
        var strLen = msg.readUInt8(i);
        i += 1;
        msgObj.iid = msg.readUIntBE(i, strLen).toString('ascii');
        i += strLen;
        path = path + '/' + msgObj.iid;
        if (msg.length > (3 + strLen)) { // 3: oidLength + strLen
            msgObj.rid = msg.readUInt16LE(i);
            i += 2;
            path = path + '/' + msgObj.rid;
        }
    }

    nutils.getSoTurnToLwm2mTlv(so).then(function (tlvObjs) {
        var soObjs;

        _.forEach(tlvObjs.oids, function (oidVal, oId) {
            if (msgObj.oid === parseInt(oidVal.slice(1))) {
                if (msgObj.iid) {
                    _.forEach(tlvObjs.objs[oId], function (ridObjs, iid) {
                        if (msgObj.iid === iid)
                            soObjs = ridObjs;
                    });
                } else {
                    soObjs = tlvObjs.objs[oId];
                }

                if (msgObj.rid) {
                    _.forEach(soObjs, function (val, rid) {
                        if (msgObj.rid === rid)
                            soObjs = val;
                    });
                }
                status = 205;   // Content
            } else {
                status = 404;   // NotFound
            }
        });

        return soObjs;
    }).then(function (soObjs) {
        console.log('soObjs');
        console.log(soObjs);
        // soObjs example: { '0': { sensorValue: 21, units: 'C' } }
        // [TODO] turn sensorValue & units to number
        var payload = lwm2mEncode('tlv', path, soObjs);
        return payload;
    }).then(function (payload) {
        var dataArray = [],
            dataBuf;

        // mhdr: mType: unconfirm data up
        dataArray.push(0x40);
        // devAddr
        for (var i = 0;i < 4;i += 1)
            dataArray.push((noraED.info.devAddr >> (i * 8)) & 0xff);
        // fCtrl uplink: ADR(1), ADRACKReq(1), ACK(1) = true, RFU(1), FOptsLen(4)
        dataArray.push(0x20);
        //fCnt
        noraED.count += 1;
        for (var i = 0;i < 2;i += 1)
            dataArray.push((noraED.count >> (i * 8)) & 0xff);
        // FPort: read
        dataArray.push(0x09);
        // payload
        // data format: tlv
        dataArray.push(0x20);
        // console.log('payload');
        // console.log(payload);
        // [TODO] encrypt payload
        // payload = nutils.frmPayloadcrypto(noraED, 0, payload, noraED.info.appSKey);
        // for (var i = 0;i < payload.length;i += 1)
        //     dataArray.push(payload[i]);
        // 08 00 0b e4 16 44 41 a8 00 00 e1 16 45 43
        // status
        for (var i = 0;i < 2;i += 1)
            dataArray.push((status >> (i * 8)) & 0xff);
        var testBuf = [0x08 ,0x00 ,0x0b ,0xe4 ,0x16 ,0x44 ,0x41 ,0xa8 ,0x00 ,0x00 ,0xe1 ,0x16 ,0x45 ,0x43];
        for (var i = 0;i < testBuf.length;i += 1)
            dataArray.push(testBuf[i]);
        // mic
        dataBuf = nutils.addMic(noraED, new Buffer(dataArray), 0);
        console.log('dataBuf');
        console.log(dataBuf);
        noraED._nora.cilentFakeTxData(dataBuf);
        // return hal.send(data);
    }).done();


    // [TODO] TLV format
    // data store in nora-end-device smartobject

};

// [TODO]
// msgHandler.macCmdHandler = function (nora, ) {

// }

msgHandler._msgDispatch = function (device, data, callback) {
    var deferred = Q.defer();

    // console.log(data);
    if (data.mhdr.mType === CNST.MType.JOINREQUEST) {   // joinRequest
    } else if (data.mhdr.mType === CNST.MType.JOINACCEPT) { // joinAccept
        console.log('noraED joinAccept');
        msgHandler._joinAcptHandler(device, data);
    } else if (data.mhdr.mType === CNST.MType.UNCONFIRMDATAUP | data.mhdr.mType === CNST.MType.CONFIRMDATAUP) {    // other message type
    } else if (data.mhdr.mType === CNST.MType.UNCONFIRMDATADOWN | data.mhdr.mType === CNST.MType.CONFIRMDATADOWN) {
        console.log('noraED downlink');
        msgHandler._downlinkHandler(device, data).then(function (data) {
            console.log('downlink data');
            // console.log(data);
            deferred.resolve(data);
        });
    }

    return deferred.promise.nodeify(callback);
};
// for nora
// msgHandler._joinReqHandler = function (nora, data, callback) {
//     function checkDevEUIAndAppEUI(otaaRegData) {
//         var joinReqMicArray = [],
//             // joinReqMicBuf,
//             joinReqMic,
//             micCheck;
//         if ((data.devEUI === otaaRegData.devEUI) & (data.appEUI === otaaRegData.appEUI)) {  // check devEUI & appEUI
//             // Generate & check MIC
//             // cmac = aes128_cmac(AppKey, MHDR | AppEUI | DevEUI | DevNonce)
//             // MIC = cmac[0..3]
//             joinReqMicArray.push(data.mhdrByte);
//             for (var i = 0;i < 8;i += 1)
//                 joinReqMicArray.push(data.appEUI[i]);
//             for (var i = 0;i < 8;i += 1)
//                 joinReqMicArray.push(data.devEUI[i]);
//             for (var i = 0;i < 2;i += 1)
//                 joinReqMicArray.push(data.devNonce[i]);
//             // joinReqMicBuf = new Buffer(joinReqMicArray);
//             joinReqMic = aesCmac((new Buffer(otaaRegData.appKey)), (new Buffer(joinReqMicArray)), { returnAsBuffer: true });
//             micCheck = ((joinReqMic[0] << 24) | (joinReqMic[1] << 16) | (joinReqMic[2] << 8) | (joinReqMic[3] << 0));
//             // if (data.mic === micCheck) {    // MIC correct
//                 // OTAA join-procedure
//                 // add devNonce & mhdr to joinData
//                 otaaRegData.mhdr = data.mhdr;
//                 otaaRegData.devNonce = data.devNonce;
//                 // return otaaRegData;
//             // } else {
//                 // otaaRegData = null;
//             // }
//         } else {
//             otaaRegData = null;
//         }

//         if (otaaRegData) {
//             // add to prepare-join-list
//             nora._joinBox.push(otaaRegData);
//             // [TODO] if end-device do not receive joinAccept message?
//             // [TODO] delay rxDelay? send joinAccept message
//             nora._joinAccept(otaaRegData.devEUI, otaaRegData, otaaRegData.appKey, function (err) {
//                 if (err)
//                     deferred.reject(err);
//             });
//         }
//     }
//     // search devNonce in database(objectbox)
//     nora._devBox.findFromDb({ devNonce: data.devNonce }, function (err, dev) {    // dev is array
//         if (dev.length === 0) { // devNonce do not exist in database
//             nora._devBox.findFromDb({ devEUI: data.devEUI }, function (err, dev) {
//                 if (dev.length === 0) {
//                     console.log('devEUI not exist');
//                     // search OTAA register box
//                     nora._otaaRegBox.find(function (otaaRegData) {
//                         checkDevEUIAndAppEUI(otaaRegData);
//                     });
//                 } else {
//                     var pastData;
//                     // pastData.devEUI = dev[0].devEUI;
//                     // dev[0]: status, option, devEUI, appEUI, devNonce, devAddr, netId, appNonce, rx1DROffset
//                     //         rx2DR, rxDelay, version, lifetime, joinTime, nextPingSlotTime, objList, so, id , _id
//                     // console.log();
//                     dev[0].devNonce = data.devNonce;
//                     nora._pastDevBox.push(dev[0]);  // information need to be check
//                     // old device disconnect from sever but it wants to connect to server again 
//                     // dev[0];
//                     // [TODO] response joinAccept
//                     nora._joinAccept(dev[0].devEUI, dev[0], dev[0].appKey); // appKey need to be decrypted
//                     // need to maintain information until new uplink
//                     console.log('devEUI exist');
//                 }
//             });
//         }
//     });
// };
// for end-device
msgHandler._joinAcptHandler = function (device, data, callback) {
    // device = nora.find(data.devAddr);
    // encrypt with appKey
    // aes128_decrypt(AppKey, AppNonce | NetID | DevAddr | DLSettings | RxDelay | CFList | MIC)
    Q.fcall(function () {
        var joinAcptArray = [];
        for (var i = 0;i < 3;i += 1)
            joinAcptArray.push((data.appNonce >> (i * 8)) & 0xff);
        for (var i = 0;i < 3;i += 1)
            joinAcptArray.push((data.netId >> (i * 8)) & 0xff);
        for (var i = 0;i < 4;i += 1)
            joinAcptArray.push((data.devAddr >> (i * 8)) & 0xff);
        joinAcptArray.push(data.dlSettings);
        joinAcptArray.push(data.rxDelay);
        // [TODO] CFList use or not
        if (data.cfList) {
            for (var i = 0;i < 16;i += 1)
                joinAcptArray.push((data.cfList >> (i * 8)) & 0xff);
        }
        for (var i = 3;i > -1;i -= 1)
            joinAcptArray.push((data.mic >> (i * 8)) & 0xff);

        return new Buffer(joinAcptArray);
    }).then(function (msgBuf) {
        var decryptData,
            cipher;
        // [TODO] encrypt data
        cipher = crypto.createCipher('aes128', device.info.appKey);
        decryptData = cipher.update(msgBuf);
        // it does not need to use .final()
        // decryptData = decipher.final();
        return decryptData;
    }).then(function (decryptData) {
        var i = 0;
        // parse data
        data.appNonce = decryptData.readUIntLE(i, 3);
        i += 3;
        data.netId = decryptData.readUIntLE(i, 3);
        i += 3;
        data.devAddr = decryptData.readUIntLE(i, 4);
        i += 4;
        data.dlSettings = decryptData.readUInt8(i);
        i += 1;
        data.rxDelay = decryptData.readUInt8(i);
        i += 1;
        if (data.length === 33) {
            data.cfList = decryptData.readUIntLE(i, 16);
            i += 16;
        }
        data.mic = decryptData.readUIntBE(i, 4);
        i += 4;

        console.log(data);
        return data;

    }).then(function (data) {
        var joinAcptMicArray = [],
            joinAcptMic,
            micCheck;
        // check mic
        // cmac = aes128_cmac(AppKey, MHDR | AppNonce | NetID | DevAddr | DLSettings | RxDelay | CFList)
        // MIC = cmac[0..3]
        joinAcptMicArray.push(data.mhdrByte);
        for (var i = 0;i < 3;i += 1)
            joinAcptMicArray.push((data.appNonce >> (i * 8)) & 0xff);
        for (var i = 0;i < 3;i += 1)
            joinAcptMicArray.push((data.netId >> (i * 8)) & 0xff);
        for (var i = 0;i < 4;i += 1)
            joinAcptMicArray.push((data.devAddr >> (i * 8)) & 0xff);
        joinAcptMicArray.push(data.dlSettings);
        joinAcptMicArray.push(data.rxDelay);
        // [TODO] CFList use or not
        if (data.cfList) {
            for (var i = 0;i < 16;i += 1)
                joinAcptMicArray.push((data.cfList >> (i * 8)) & 0xff);
        }

        joinAcptMic = aesCmac(device.info.appKey, new Buffer(joinAcptMicArray), { returnAsBuffer: true });
        micCheck = ((joinAcptMic[0] << 24) | (joinAcptMic[1] << 16) | (joinAcptMic[2] << 8) | (joinAcptMic[3] << 0));
        // console.log(micCheck);
        // console.log(data.mic);

        if (data.mic === micCheck) {    // MIC scorrect
            console.log('mic equal');
            device.info.appNonce = data.appNonce;
            device.info.netId = data.netId;
            device.info.devAddr = data.devAddr;
            device.dlSettings = data.dlSettings;
            device.rxDelay = data.rxDelay;
            if (data.cfList)
                device.cfList = data.cfList;

            device._connectedStatus = 'connected';
            device.count = 0;
            setImmediate(function () {
                device.emit('connected');
            });
        } else {

        }
    }).done();

    // [TODO] ?
};
// for nora
// msgHandler._uplinkHandler = function (nora, data, callback) {
//     var deferred = Q.defer(),
//         FHDR = data.macPayload.fhdr;
//     // check join procedure
//     nora._joinBox.find(function (joinData) {
//         var end_device,
//             len = -1;
//         if (joinData.devAddr === FHDR.devAddr) {
//             console.log('create end-device');
//             // create end-device instance
//             end_device = new NoraEndDevice(nora, joinData);
//             nora._devBox.add(end_device, function (err) {
//                 if (err)
//                     deferred.reject(err);
//             });
//             len = nora._joinBox.indexOf(joinData);
//             if (len > -1)
//                 nora._joinBox.splice(len, 1);   // delete this joinData content
//             len = nora._otaaRegBox.indexOf(joinData);
//             if (len > -1)
//                 nora._otaaRegBox.splice(len, 1);   // delete this regData content
//         } else {
//             console.log('find end-device');
//             // search devAddr in database(objectbox)
//             end_device = nora.find(FHDR.devAddr);
//             // console.log(end_device);
//             // [TODO] how to update to new one devNonce?
//             // how to get devNonce
//             // nora._devBox.findFromDb();
//             // if (count === 1)?
//             if (!end_device)
//                 deferred.reject('End-device 0x' + FHDR.devAddr + ' does not exist.');
//             else {
//                 nora._pastDevBox.find(function (pastDevData) {
//                     console.log('pastDevData');
//                     console.log(pastDevData);
//                     if (end_device.info.devEUI === pastDevData.devEUI) {
//                         console.log('devEUI equal');
//                         // delete end-device instance
//                         nora._endDeviceBox[pastDevData.devAddr] = null;
//                         delete nora._endDeviceBox[pastDevData.devAddr];
//                         // remove infomation from database
//                         nora._devBox.remove(pastDevData.id, function (err, id) {
//                             if (err)
//                                 deferred.reject(err);
//                         });
//                         // create new end-device instance, devNonce is already new one
//                         end_device = new NoraEndDevice(nora, pastDevData);
//                         nora._devBox.set(pastDevData.id, end_device, function (err) {
//                             if (err)
//                                 deferred.reject(err);
//                         });
//                     }
//                 });
//             }
//         }
//         if (end_device) {
//             if (nutils.checkMic(end_device, data, 0)) {
//                 // deferred.resolve(nutils.decryptPayload(end_device, data));
//                 deferred.resolve(data);
//             }
//         }
//     });

//     return deferred.promise.nodeify(callback);
// };
// for end-device
msgHandler._downlinkHandler = function (device, data, callback) {
    var deferred = Q.defer(),
        FHDR = data.macPayload.fhdr,
        FPort = data.macPayload.fPort,
        Mic = data.mic,
        Payload = data.macPayload.payload;
    // Generate & check MIC
    // cmac = aes128_cmac(NwkSKey, B0 | msg)
    // MIC = cmac[0..3]
    // msg = MHDR | FHDR | FPort | FRMPayload
    // B0: 0x49 | 0x00000000 | Dir | DevAddr | FCntUp/FCntDown | 0x00 | len(msg)
    // Dir: 0: uplink, 1: downlink
    var msgArray = [],
        msgBuf,
        cmac,
        mic;

    msgArray.push(0x49);
    for (var i = 0;i < 4;i += 1)
        msgArray.push(0x00);
    // dir
    msgArray.push(0x01);
    // devAddr
    for (var i = 0;i < 4;i += 1)
        msgArray.push(((FHDR.devAddr >> (8 * i)) & 0xff));
    // FCnt(up/down)
    for (var i = 0;i < 4;i += 1)
        msgArray.push(((FHDR.fCnt >> (8 * i)) & 0xff));
    msgArray.push(0x00);
    msgArray.push(data.phyPayloadLength - 4);
    // msg
    // mhdr
    msgArray.push(data.mhdrByte);
    // devAddr
    for (var i = 0;i < 4;i += 1)
        msgArray.push(((FHDR.devAddr >> (8 * i)) & 0xff));
    // FCtrl
    msgArray.push(FHDR.fCtrlByte);
    // FCnt(up/down)
    for (var i = 0;i < 4;i += 1)
    msgArray.push(((FHDR.fCnt >> (8 * i)) & 0xff));
    if (FHDR.fCtrl.fOptsLen !== 0)
        msgArray.push(FHDR.fOpts);
    if (FPort !== null) {
        msgArray.push(FPort);
        for (var i = 0;i < Payload.length;i += 1)
            msgArray.push(Payload[i]);
    }
    msgBuf = new Buffer(msgArray);
    // console.log('device.info.nwkSKey: ' + device.info.nwkSKey);
    cmac = aesCmac(device.info.nwkSKey, msgBuf, { returnAsBuffer: true });
    mic = ((cmac[0] << 24) | (cmac[1] << 16) | (cmac[2] << 8) | (cmac[3] << 0));
    // check mic correction
    // console.log('mic');
    // console.log(mic);
    // console.log('Mic');
    // console.log(Mic);
    // if (mic === Mic) {
    //     if ((device.count + 1) === FHDR.fCnt) // check frame counter, fix counter
    //         device.count = FHDR.fCnt;
        // [TODO] if count > 0xffffffff?
        if (FPort === null) {
                // empty payload
                // deferred.resolve(null);
        } else if (FPort === 0x00) {  // Payload is MAC command
            // decrypt FRMPayload
            // Payload = nutils.frmPayloadcrypto(device, Payload, device.info.nwkSKey);
        } else {    // Payload is application data, [TODO] use different interface? lwm2m...
            // Payload = nutils.frmPayloadcrypto(device, Payload, device.info.appSKey);
        }
        data.macPayload.payload = Payload;
        deferred.resolve(data);
        // return data;
        // [TODO]
    // }

    return deferred.promise.nodeify(callback);
};

// msgHandler._objectDetailReq = function (noraED, devAddr, objListOfSo, callback) {
//     var readAllObjectPromises = [],
//         oids = [];
    // var noraED = nora.find(devAddr);
    // before readReq, device need to be registered
    // noraED._registered = true;
    // read every object => dig into the structure and id-name transform
    // _.forEach(objListOfSo, function (iids, oid) {
    //     var oidNum = nutils.oidNum(oid);
    //     oids.push(oidNum);
    //     readAllObjectPromises.push(noraED.readReq('/' + oidNum));
    // });

    // noraED.readReq('/3303').then(function(rsp) {
    //     console.log('rsp');
    //     console.log(rsp);
    // });


    // noraED.dataPendingCount = readAllObjectPromises.length;
    // does it really to readReq one by one?
    // return Q.all(readAllObjectPromises).then(function (rsps) {
    //     console.log('rsps');
    //     console.log(rsps);
    //     // [TODO] wait all rsp response?how?
    //     var objs = {},
    //         isAnyFail = false;
    //     // after read all resources, register turn to false
    //     noraED._registered = false;
    //     _.forEach(rsps, function (rsp, idx) {
    //         var obj = rsp.payload,
    //             oid = oids[idx];

    //         if (rsp.status === 205) {   // content
    //             _.forEach(rsp.data, function (iObj, iid) {
    //                 var rsc = [];

    //                 _.forEach(iObj, function (val, rid) {
    //                     rsc[rid] = val;
    //                 });

    //                 noraED.so.init(oid, iid, rsc);
    //             });
    //         } else {
    //             isAnyFail = true;
    //         }
    //     });

    //     if (isAnyFail)
    //         throw new Error('Object requests fail.');
    //     else {
    //         objs.status = rsp.status;
    //         objs.data = noraED.so;
    //         return objs;
    //     }
    // }).nodeify(callback);
// };

msgHandler.dispatchEvent = function (device, data) {
    var FHDR = data.macPayload.fhdr,
        FPort = data.macPayload.fPort,
        Payload = data.macPayload.payload,
        cmd = '',
        j = 0,
        eventName;
        // noraED = nora.find(FHDR.devAddr);

    if (!device)
        return;

    if (FHDR.fCtrl.fOptsLen === 0) {    // FOpts not existed
        if (FPort === null) {
            // empty payload
        } else if (FPort === 0x00) {  // Payload is MAC command
            // [TODO] Payload need to decrease Payload[0]
            var cmdId = Payload.readUInt8(j);
            j += 1;
            eventName = 'macCmd';
            switch(cmdId) {
                case 2:  // 0x02
                    cmd = 'linkCheckAns';
                    break;
                case 3:  // 0x03
                    // status: rfu, power ack, data rate ack, channel mask ack
                    cmd = 'linkAdrReq';
                    break;
                case 4:  // 0x04
                    cmd = 'dutyCycleReq';
                    break;
                case 5:  // 0x05
                    // status: rfu, rx1DROffset ack, rx2 data rate ack, channel ack
                    cmd = 'rxParamSetupReq';
                    break;
                case 6:  // 0x06
                    // battery, margin
                    cmd = 'devStatusReq';
                    break;
                case 7:  // 0x07
                    // status: rfu, data rate range ok, channel frequency ok
                    cmd = 'newChannelReq';
                    break;
                case 8:  // 0x08
                    cmd = 'rxTimingSetupReq';
                    break;
                case 9:  // 0x09
                    cmd = 'txParamSetupReq';
                    break;
                case 10: // 0x0a
                    // status: rfu, uplink frequency exists, channel frequency ok
                    cmd = 'diChannelReq';
                    break;
            }
        } else {    // Payload is application data
            // [TODO] fire event with different FPort(example: bootstrapReq, readRsp, ...)
            // event: 'register'. devIncoming should be fire after device registered successful.
            // data format & [TODO] message continue or not?(need to be queued)
            // [TODO] according to data format, payload need to be parsed to different format
            var dataFormat = Payload.readUInt8(j);
            // data format: bit: 7~6: rfu
            //              bit: 5~4: data format
            //              bit: 3  : more data to be transmit
            //              bit: 2~0: rfu
            j += 1;

            // [TODO] TLV format?
            // Payload = Payload.slice(1);
            eventName = 'lwm2mCmd';

            if ((dataFormat & 0x30) === 0x30) { // JSON format. it is not lwm2m json format, just normal json format
                Payload = Payload.toString('ascii');
                Payload = JSON.parse(Payload);
                Payload.devAddr = device.info.devAddr;
            } else if ((dataFormat & 0x30) === 0x20) {  // TLV format
                // [TODO] TLV format
                // lwm2mDecode
                // lwm2mEncode
            }
            // console.log('FPort');
            // console.log(FPort);
            switch(FPort) {
                // case 1:  // 0x01
                //     cmd = 'bootstrapReq';
                // break;
                // case 2:  // 0x02
                //     cmd = 'bootstrapFinishRsp';
                // break;
                // case 3:  // 0x03
                //     cmd = 'bootstrapWriteRsp';
                // break;
                // case 4:  // 0x04
                //     cmd = 'bootstrapDiscoverRsp';
                // break;
                // case 5:  // 0x05
                //     cmd = 'bootstrapDeleteRsp';
                // break;
                case 6:  // 0x06
                    // register info: devAddr, lifetime, lwm2m version, objects & object instances [MUST]
                    cmd = 'registerRsp';
                    msgHandler._registerHandler(device, Payload);
                    break;
                case 7:  // 0x07
                    // update info: lifetime ,binding mode ,SMS number ,objects & object instances [OPTIONAL]
                    cmd = 'updateRsp';
                    msgHandler._updateHandler(device, Payload);
                    break;
                case 8:  // 0x08
                    // de-register info: none
                    cmd = 'deregisterRsp';
                    msgHandler._deregisterHandler(device, Payload);
                    break;
                case 9:  // 0x09
                    cmd = 'readReq';
                    console.log('readReq');
                    // TLV?
                    msgHandler._readReqHandler(device, Payload);
                    // Payload: status: , data: {}
                    break;
                case 10: // 0x0a
                    cmd = 'writeReq';
                    // Payload: status: 
                    break;
                case 11: // 0x0b
                    cmd = 'executeReq';
                    // Payload: status: 
                    break;
                case 12: // 0x0c
                    cmd = 'createReq';
                    break;
                case 13: // 0x0d
                    cmd = 'deleteReq';
                    break;
                case 14: // 0x0e
                    cmd = 'discoverReq';
                    // Payload: status: , data: {}
                    break;
                case 15: // 0x0f
                    cmd = 'writeAttrsReq';
                    // Payload: status: 
                    break;
                case 16: // 0x10
                    cmd = 'observationReq';
                    // Payload: status: , data: {}
                    break;
                case 17: // 0x11
                    cmd = 'cancelObervationReq';
                    break;
                case 18: // 0x12
                    // notify info: update value [MUST]
                    cmd = 'notifyRsp';
                    msgHandler._notifyHandler(device, Payload);
                    break;
            }
       }
    } else {    // FOpts existed, MAC Command
        var cmdId = Payload.readUInt8(j);
        j += 1;
        eventName = 'macCmd';
        switch(cmdId) {
            case 2:  // 0x02
                cmd = 'linkCheckAns';
                break;
            case 3:  // 0x03
                cmd = 'linkAdrReq';
                break;
            case 4:  // 0x04
                cmd = 'dutyCycleReq';
                break;
            case 5:  // 0x05
                cmd = 'rxParamSetupReq';
                break;
            case 6:  // 0x06
                cmd = 'devStatusReq';
                break;
            case 7:  // 0x07
                cmd = 'newChannelReq';
                break;
            case 8:  // 0x08
                cmd = 'rxTimingSetupReq';
                break;
            case 9:  // 0x09
                cmd = 'txParamSetupReq';
                break;
            case 10: // 0x0a
                cmd = 'diChannelReq';
                break;
        }
    }
    // setImmediate(function () {
    //     // [TODO] according to different cmdId, display different data contructor
    //     nora.emit(eventName, { devAddr: FHDR.devAddr, cmd: cmd, data: Payload });
    // });
}

function sendResponse(nora, intface, devAddr, status, callback) {
    var rspCode,
        rspCodeBuf,
        cmdId;

    if (!_.isString(status))
        throw new TypeError('status must be a string.');

    if (status === 'OK')
        rspCode = 200;
    else if (status === 'Created')
        rspCode = 201;
    else if (status === 'Deleted')
        rspCode = 202;
    else if (status === 'Changed')
        rspCode = 204;
    else if (status === 'BadRequest')
        rspCode = 400;
    else if (status === 'NotFound')
        rspCode = 404;
    else if (status === 'MethodNotAllowed')
        rspCode = 405;
    else if (status === 'Timeout')
        rspCode = 408;
    else if (status === 'IntervalServerError')
        rspCode = 500;
    else
        throw new Error('You got a wrong status.');

    rspCode = JSON.stringify(rspCode);
    rspCodeBuf = new Buffer(rspCode);

    if (intface === 'register')
        cmdId = 0x06;
    else if (intface === 'update')
        cmdId = 0x07;
    else if (intface === 'deregister')
        cmdId = 0x08;
    else if (intface === 'notify')
        cmdId = 0x12;
    else
        throw new Error('You got a wrong intface.');
    // devAddr, confirm, ack, pending, cmdId, payload, callback
    nora.sendMessage(devAddr, false, true, false, cmdId, rspCodeBuf, function () {
        if (_.isFunction(callback))
            callback();
    });
}

module.exports = msgHandler;