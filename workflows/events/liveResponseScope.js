// Only exact, user-owned scoped records grant access; never use legacy roots.
const validId=value=>typeof value==='string' && value.length>0 && value.length<=256 &&
  value!=='.' && value!=='..' && !/[\/\\\x00-\x1f\x7f]/.test(value);
export function validResponseScope(scope) {
  return Boolean(scope && ['userId','projectId','sessionId'].every(k=>validId(scope[k])));
}
export async function authorizeResponseScope(scope,storage) {
  if(!validResponseScope(scope))return false;
  const root='users/'+scope.userId+'/projects/'+scope.projectId;
  if(!await storage.get(root))return false;
  return Boolean(await storage.get(root+'/agentSessions/'+scope.sessionId) ||
    await storage.get(root+'/convo.sessions/'+scope.sessionId));
}
