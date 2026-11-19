// miniprogram/utils/address.js
const ADDRESS_KEY = 'pandou_addresses';
const CONTACT_KEY = 'pandou_contact';

function getAddressList() {
  const list = wx.getStorageSync(ADDRESS_KEY);
  if (Array.isArray(list) && list.length > 0) return list;
  const old = wx.getStorageSync(CONTACT_KEY);
  if (old && (old.receiverName || old.destAddress)) {
    const init = [{
      id: 'addr_default',
      name: (old.receiverName || '临安街坊').trim(),
      phone: (old.receiverPhone || '').trim(),
      area: (old.deliveryArea || '').trim(),
      detail: (old.destAddress || '').trim(),
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

function syncToContact(addr) {
  if (!addr) {
    wx.removeStorageSync(CONTACT_KEY);
    wx.setStorageSync('pandou_contact_revision', Date.now().toString(36));
    return;
  }
  wx.setStorageSync(CONTACT_KEY, {
    receiverName: addr.name || '',
    receiverPhone: addr.phone || '',
    deliveryArea: addr.area || '',
    destAddress: addr.detail || ''
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

  const record = {
    id,
    name,
    phone,
    area,
    detail,
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

function importFromWechat() {
  return new Promise((resolve, reject) => {
    wx.chooseAddress({
      success: (res) => {
        try {
          const area = res.countyName || '临安区';
          const detail = [res.provinceName, res.cityName, res.countyName, res.detailInfo]
            .filter(Boolean)
            .join(' ')
            .replace(/^(浙江省\s*|杭州市\s*)+/g, '');
          const record = saveAddress({
            name: res.userName || '顾客',
            phone: res.telNumber || '',
            area,
            detail: res.detailInfo ? `${area} ${res.detailInfo}` : detail,
            is_default: true
          });
          resolve(record);
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

module.exports = {
  ADDRESS_KEY,
  CONTACT_KEY,
  getAddressList,
  getDefaultAddress,
  saveAddress,
  deleteAddress,
  setDefaultAddress,
  importFromWechat,
  syncToContact
};
