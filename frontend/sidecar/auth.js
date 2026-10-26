// 이 복사본은 계정 서버에 로그인하지 않는다.
// 대화·프로젝트 구분에 쓰는 로컬 사용자만 이 PC에 둔다.

const LOCAL_USER = {
  user_id: 'local',
  user_name: 'KODEX',
  role: 'admin',
  department: null,
  position: null,
}

function getUser() {
  return { ...LOCAL_USER }
}

async function session() {
  return { user: getUser() }
}

async function login() {
  return getUser()
}

async function logout() {
  return { ok: true }
}

module.exports = { login, logout, session, getUser }
