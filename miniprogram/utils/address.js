// miniprogram/utils/address.js
const ADDRESS_KEY = 'pandou_addresses';
const CONTACT_KEY = 'pandou_contact';

function getAddressList() {
  const list = wx.getStorageSync(ADDRESS_KEY);
  if (Array.isArray(list) && list.length > 0) return list;
  const old = wx.getStorageSync(CONTACT_KEY);
  if (old && old.destAddress && String(old.destAddress).trim()) {
    const init = [{
      id: 'addr_default',
      name: (old.receiverName || '临安街坊').trim(),
      phone: (old.receiverPhone || '').trim(),
      area: (old.deliveryArea || '').trim(),
      detail: String(old.destAddress).trim(),
      is_default: true,
      create_time: Date.now()
    }];
    wx.setStorageSync(ADDRESS_KEY, init);
    return init;
  }
  return [];
}

function getDefaultAddress() {
  const list = getAddressList();
  if (!list.length) return null;
  return list.find(a => a.is_default) || list[0];
}

function parseCoord(raw, maxAbs) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && Math.abs(n) <= maxAbs ? n : null;
}

function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const rad = deg => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function checkDeliveryRange(addr, config) {
  const cfg = config || {};
  const areasRaw = cfg.DELIVERY_AREAS || '';
  const areas = Array.isArray(cfg.delivery_areas)
    ? cfg.delivery_areas.filter(Boolean)
    : String(areasRaw).split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
  const maxKm = Number(cfg.DELIVERY_MAX_KM || '0');
  const shopLat = parseCoord(cfg.WORKSHOP_LAT, 90);
  const shopLng = parseCoord(cfg.WORKSHOP_LNG, 180);
  const userLat = parseCoord(addr && addr.latitude, 90);
  const userLng = parseCoord(addr && addr.longitude, 180);
  const hasRadiusRule = maxKm > 0 && shopLat !== null && shopLng !== null;
  const hasUserCoords = userLat !== null && userLng !== null;
  const distanceKm = hasUserCoords && shopLat !== null && shopLng !== null
    ? calcDistanceKm(shopLat, shopLng, userLat, userLng)
    : null;

  if (areas.length === 0 && !hasRadiusRule) {
    return { ok: false, distanceKm, maxKm, reason: '当前尚未开放自送，请选择到店自提' };
  }
  if (hasUserCoords && hasRadiusRule) {
    if (distanceKm > maxKm) {
      return { ok: false, distanceKm, maxKm, reason: `距作坊约${distanceKm.toFixed(1)}公里，超出${maxKm}公里自送范围` };
    }
    return { ok: true, distanceKm, maxKm, reason: '' };
  }
  if (areas.length === 0) {
    return { ok: false, distanceKm, maxKm, reason: '请点击地图定位选址确认配送范围' };
  }
  const detail = String((addr && addr.detail) || '').trim();
  const area = String((addr && addr.area) || '').trim();
  const areaConsistent = !area || detail.includes(area);
  if (areaConsistent && areas.some(a => detail.includes(a))) {
    return { ok: true, distanceKm, maxKm, reason: '' };
  }
  return {
    ok: false,
    distanceKm,
    maxKm,
    reason: hasRadiusRule ? '地址不在主城区关键词内，建议用地图定位核验距离' : '地址不在可自送区域范围内'
  };
}

function syncToContact(addr) {
  if (!addr) {
    wx.removeStorageSync(CONTACT_KEY);
    wx.setStorageSync('pandou_contact_revision', Date.now().toString(36));
    return;
  }
  const lat = parseCoord(addr.latitude, 90);
  const lng = parseCoord(addr.longitude, 180);
  wx.setStorageSync(CONTACT_KEY, {
    receiverName: addr.name || '',
    receiverPhone: addr.phone || '',
    deliveryArea: addr.area || '',
    destAddress: addr.detail || '',
    deliveryLat: lat,
    deliveryLng: lng
  });
  wx.setStorageSync('pandou_contact_revision', Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
}

function saveAddress(addr) {
  if (!addr || typeof addr !== 'object') throw new Error('地址内容无效');
  const name = (addr.name || '').trim();
  const phone = (addr.phone || '').trim();
  const detail = (addr.detail || '').trim();
  const area = (addr.area || '').trim();
  if (!name) throw new Error('请填写收货人姓名');
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) throw new Error('请填写正确的11位联系电话');
  if (!detail) throw new Error('请填写详细收货地址');

  const list = getAddressList().slice();
  const id = addr.id || ('addr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6));
  const isDefault = Boolean(addr.is_default) || list.length === 0;

  if (isDefault) {
    list.forEach(item => { item.is_default = false; });
  }

  const lat = parseCoord(addr.latitude, 90);
  const lng = parseCoord(addr.longitude, 180);
  const record = {
    id,
    name,
    phone,
    area,
    detail,
    latitude: lat,
    longitude: lng,
    is_default: isDefault,
    update_time: Date.now()
  };

  const index = list.findIndex(item => item.id === id);
  if (index >= 0) {
    list[index] = Object.assign({}, list[index], record);
  } else {
    record.create_time = Date.now();
    list.unshift(record);
  }

  // 保证至少有一个默认地址
  if (!list.some(item => item.is_default)) {
    list[0].is_default = true;
  }

  wx.setStorageSync(ADDRESS_KEY, list);
  const currentDef = list.find(a => a.is_default) || list[0];
  syncToContact(currentDef);
  return record;
}

function deleteAddress(id) {
  let list = getAddressList().filter(item => item.id !== id);
  if (list.length > 0 && !list.some(item => item.is_default)) {
    list[0].is_default = true;
  }
  wx.setStorageSync(ADDRESS_KEY, list);
  const def = list.find(a => a.is_default);
  syncToContact(def || null);
  return list;
}

function setDefaultAddress(id) {
  const list = getAddressList().map(item => {
    item.is_default = (item.id === id);
    return item;
  });
  wx.setStorageSync(ADDRESS_KEY, list);
  const def = list.find(a => a.id === id) || list[0];
  syncToContact(def || null);
  return list;
}

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/[\s\-()（）]/g, '');
  if (/^\+?861[3-9]\d{9}$/.test(digits)) {
    digits = digits.replace(/^\+?86/, '');
  }
  return digits;
}

function importFromWechat(deliveryAreas) {
  const areas = Array.isArray(deliveryAreas) ? deliveryAreas.filter(Boolean) : [];
  return new Promise((resolve, reject) => {
    wx.chooseAddress({
      success: (res) => {
        try {
          const county = (res.countyName || '').trim();
          const rawDetail = (res.detailInfo || '').trim();
          const matchedArea = areas.find(a => rawDetail.includes(a) || county.includes(a)) || '';
          const area = matchedArea || county || '临安区';
          let detail = '';
          if (matchedArea) {
            detail = rawDetail.includes(matchedArea) ? rawDetail : `${matchedArea} ${rawDetail}`.trim();
          } else if (rawDetail) {
            detail = county && !rawDetail.includes(county) ? `${county} ${rawDetail}` : rawDetail;
          } else {
            detail = [res.provinceName, res.cityName, county]
              .filter(Boolean)
              .join(' ')
              .replace(/^(浙江省\s*|杭州市\s*)+/g, '')
              .trim();
          }
          const name = (res.userName || '顾客').trim();
          const phone = normalizePhone(res.telNumber);
          if (!/^1[3-9]\d{9}$/.test(phone)) {
            const err = new Error('微信地址缺少11位有效手机号，请手动补充');
            err.code = 'INVALID_PHONE';
            err.draft = { name, phone: (res.telNumber || '').trim(), area: matchedArea || county, detail };
            reject(err);
            return;
          }
          const record = saveAddress({
            name,
            phone,
            area,
            detail,
            is_default: true
          });
          resolve(Object.assign({}, record, {
            matchedWhitelist: areas.length === 0 || Boolean(matchedArea)
          }));
        } catch (err) {
          reject(err);
        }
      },
      fail: (err) => {
        reject(err);
      }
    });
  });
}

function chooseLocation() {
  return new Promise((resolve, reject) => {
    wx.chooseLocation({
      success: (res) => {
        const poiName = (res.name || '').trim();
        const fullAddr = (res.address || '').trim();
        const cleanAddr = fullAddr.replace(/^(浙江省\s*|杭州市\s*)+/g, '').trim();

        const area = poiName || cleanAddr;
        const detail = poiName && cleanAddr && !cleanAddr.includes(poiName) 
          ? `${cleanAddr} ${poiName}` 
          : (cleanAddr || poiName);

        resolve({
          name: poiName,
          address: fullAddr,
          cleanAddress: cleanAddr,
          area,
          detail,
          latitude: res.latitude,
          longitude: res.longitude
        });
      },
      fail: (err) => {
        if (err && (err.errMsg || '').includes('cancel')) {
          reject(new Error('cancel'));
        } else {
          reject(err || new Error('定位选址失败'));
        }
      }
    });
  });
}

module.exports = {
  ADDRESS_KEY,
  CONTACT_KEY,
  calcDistanceKm,
  checkDeliveryRange,
  getAddressList,
  getDefaultAddress,
  saveAddress,
  deleteAddress,
  setDefaultAddress,
  importFromWechat,
  chooseLocation,
  syncToContact
};
