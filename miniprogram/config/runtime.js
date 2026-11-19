// User-authorized test-account integration: only the development build uses the
// local server and simulated identities. Trial/release await a formal account.
const environments = {
  develop: {cloudEnvId:'', serviceName:'pandou', allowLocalDev:true, localBaseUrl:'http://127.0.0.1:18080'},
  trial: {cloudEnvId:'', serviceName:'pandou'},
  release: {cloudEnvId:'', serviceName:'pandou'}
};

function selectRuntime(version) {
  const config = environments[version] || {};
  return {runtimeVersion:version || 'unknown', cloudEnvId:config.cloudEnvId || '',
    serviceName:config.serviceName || 'pandou',
    allowLocalDev:version === 'develop' && config.allowLocalDev === true,
    localBaseUrl:version === 'develop' ? config.localBaseUrl : ''};
}

module.exports = {selectRuntime};
