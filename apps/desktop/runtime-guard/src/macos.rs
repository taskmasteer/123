//! Fixed resource-only roles. No Tauri, credential store, shell, PID selector or general broker.
use site_factory_runtime_guard::{
    owner_socket::{OwnerListener, WorkerPaths},
    validate, BrowserRequest, Ownership,
};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{fs::PermissionsExt, net::UnixStream, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Invalid owned runtime channel",
    )
}
fn runtime() -> Result<PathBuf> {
    Ok(env::current_exe()?
        .parent()
        .ok_or_else(invalid)?
        .parent()
        .ok_or_else(invalid)?
        .canonicalize()?)
}
fn poll(fd: RawFd, timeout: i32) -> io::Result<bool> {
    let mut p = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let n = unsafe { libc::poll(&mut p, 1, timeout) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(n > 0)
}
fn line(stream: &mut UnixStream, maximum: usize) -> Result<String> {
    let mut bytes = Vec::new();
    loop {
        let mut b = [0];
        if stream.read(&mut b)? == 0 {
            return Err(invalid().into());
        }
        if b[0] == 10 {
            break;
        }
        bytes.push(b[0]);
        if bytes.len() > maximum {
            return Err(invalid().into());
        }
    }
    Ok(String::from_utf8(bytes)?)
}
fn duplicate(fd: RawFd) -> io::Result<OwnedFd> {
    let out = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 64) };
    if out < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(out) })
    }
}
fn send_request(stream: &UnixStream, request: &BrowserRequest) -> Result<()> {
    let mut bytes = serde_json::to_vec(request)?;
    bytes.push(10);
    if bytes.len() > 65536 {
        return Err(invalid().into());
    }
    let mut control = vec![0usize; unsafe { libc::CMSG_SPACE(16) } as usize / 8 + 1];
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = unsafe { libc::CMSG_SPACE(16) };
    unsafe {
        let c = libc::CMSG_FIRSTHDR(&msg);
        (*c).cmsg_level = libc::SOL_SOCKET;
        (*c).cmsg_type = libc::SCM_RIGHTS;
        (*c).cmsg_len = libc::CMSG_LEN(16);
        std::ptr::copy_nonoverlapping([1i32, 2, 3, 4].as_ptr(), libc::CMSG_DATA(c).cast(), 4);
    }
    let n = unsafe { libc::sendmsg(stream.as_raw_fd(), &msg, 0) };
    if n < 0 {
        return Err(io::Error::last_os_error().into());
    }
    if n as usize != bytes.len() {
        let mut rest = stream;
        rest.write_all(&bytes[n as usize..])?;
    }
    Ok(())
}
fn receive_request(stream: &mut UnixStream) -> Result<(BrowserRequest, Vec<OwnedFd>)> {
    let mut bytes = vec![0u8; 65536];
    let mut control = vec![0usize; 16];
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr().cast();
    msg.msg_controllen = (control.len() * 8) as _;
    let n = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut msg, 0) };
    if n <= 0 {
        return Err(invalid().into());
    }
    let mut fds = Vec::new();
    unsafe {
        let mut c = libc::CMSG_FIRSTHDR(&msg);
        while !c.is_null() {
            if (*c).cmsg_level != libc::SOL_SOCKET || (*c).cmsg_type != libc::SCM_RIGHTS {
                return Err(invalid().into());
            }
            let length = (*c).cmsg_len as usize;
            if length < libc::CMSG_LEN(0) as usize || length > control.len() * 8 {
                return Err(invalid().into());
            }
            let size = length - libc::CMSG_LEN(0) as usize;
            if size % 4 != 0 {
                return Err(invalid().into());
            }
            for i in 0..size / 4 {
                fds.push(OwnedFd::from_raw_fd(
                    *libc::CMSG_DATA(c).cast::<i32>().add(i),
                ));
            }
            c = libc::CMSG_NXTHDR(&msg, c);
        }
    }
    if fds.len() != 4 || msg.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 {
        return Err(invalid().into());
    }
    bytes.truncate(n as usize);
    while !bytes.ends_with(b"\n") {
        let mut b = [0];
        if stream.read(&mut b)? == 0 || bytes.len() >= 65536 {
            return Err(invalid().into());
        }
        bytes.push(b[0]);
    }
    if bytes[..bytes.len() - 1].contains(&10) {
        return Err(invalid().into());
    }
    let request = serde_json::from_slice(&bytes)?;
    let safe = fds
        .iter()
        .map(|f| duplicate(f.as_raw_fd()))
        .collect::<io::Result<Vec<_>>>()?;
    Ok((request, safe))
}
fn verify_proxy(stream: &UnixStream) -> Result<()> {
    let mut pid: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&pid) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut length,
        )
    } != 0
    {
        return Err(invalid().into());
    }
    let (mut uid, mut gid) = (0, 0);
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid != unsafe { libc::geteuid() }
        || unsafe { libc::getpgid(pid) } != pid
    {
        return Err(invalid().into());
    }
    let mut path = [0u8; 4096];
    let n = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if n <= 0 {
        return Err(invalid().into());
    }
    let end = path.iter().position(|b| *b == 0).unwrap_or(n as usize);
    if Path::new(std::str::from_utf8(&path[..end])?).canonicalize()?
        != env::current_exe()?.canonicalize()?
    {
        return Err(invalid().into());
    }
    Ok(())
}
/// Child PID remains reserved: never try_wait/reap until its group has been signalled.
struct OwnedGroup {
    child: Child,
    state: Ownership,
    group: bool,
}
impl OwnedGroup {
    fn new(child: Child) -> Self {
        let mut state = Ownership::default();
        state.track();
        Self {
            child,
            state,
            group: true,
        }
    }
    fn exited(&self) -> io::Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let n = unsafe {
            libc::waitid(
                libc::P_PID,
                self.child.id() as _,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if n < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { info.si_pid() } != 0)
    }
    fn stop(&mut self) -> io::Result<()> {
        if self.state.cleanup().is_ok() {
            unsafe {
                libc::kill(
                    if self.group {
                        -(self.child.id() as i32)
                    } else {
                        self.child.id() as i32
                    },
                    libc::SIGKILL,
                );
            };
            let _ = self.child.wait()?;
            self.state.reap().map_err(|_| invalid())?;
        }
        Ok(())
    }
}
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
fn own_group_stop() -> ! {
    unsafe {
        let pid = libc::getpid();
        if libc::getpgrp() == pid {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    std::process::exit(1)
}
fn anchor(kind: &str, args: &[String]) -> Result<()> {
    struct OwnGroup;
    impl Drop for OwnGroup {
        fn drop(&mut self) {
            own_group_stop();
        }
    }
    let _group = OwnGroup;
    if unsafe { libc::fcntl(5, libc::F_GETFD) } < 0 {
        return Err(invalid().into());
    }
    let mut owner = unsafe { UnixStream::from_raw_fd(5) };
    // fd5 must be the private socketpair from our direct fixed-helper parent.
    // The internal role is not a public profile/argument launch interface.
    verify_proxy(&owner)?;
    let mut peer: libc::pid_t = 0;
    let mut length = std::mem::size_of_val(&peer) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            owner.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut peer as *mut libc::pid_t).cast(),
            &mut length,
        )
    } != 0
        || peer != unsafe { libc::getppid() }
    {
        return Err(invalid().into());
    }
    let temp = PathBuf::from(env::var("TMPDIR")?);
    let request = BrowserRequest {
        token: "a".repeat(64),
        kind: kind.into(),
        args: args.to_vec(),
        env: BTreeMap::new(),
    };
    validate(&request, &request.token, &temp).map_err(|_| invalid())?;
    owner.set_read_timeout(Some(Duration::from_secs(5)))?;
    if line(&mut owner, 32)? != "GO" {
        own_group_stop();
    }
    owner.set_read_timeout(None)?;
    let root = runtime()?;
    let browser=match kind{"full"=>root.join("browsers/chromium-1248").join(if cfg!(target_arch="aarch64"){"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"}else{"chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"}),"headless"=>root.join("browsers/chromium_headless_shell-1248").join(if cfg!(target_arch="aarch64"){"chrome-headless-shell-mac-arm64/chrome-headless-shell"}else{"chrome-headless-shell-mac-x64/chrome-headless-shell"}),_=>return Err(invalid().into())};
    // Only descriptors3/4 and the selected safe environment reach Chromium. fd5 is owner-only.
    unsafe {
        libc::fcntl(5, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let mut command = Command::new(browser);
    command.args(args).stdin(Stdio::null()).env_clear();
    for key in ["HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut browser = command.spawn()?;
    let code = loop {
        if poll(owner.as_raw_fd(), 100)? {
            let mut b = [0];
            if owner.read(&mut b)? == 0 {
                own_group_stop();
            }
            own_group_stop();
        }
        if let Some(status) = browser.try_wait()? {
            break status.code().unwrap_or(1);
        }
    };
    writeln!(owner, "EXIT {code}")?;
    if !poll(owner.as_raw_fd(), 5000)? {
        own_group_stop();
    }
    own_group_stop()
}
fn browser_connection(
    mut proxy: UnixStream,
    token: String,
    temp: PathBuf,
    stopping: Arc<AtomicBool>,
    force: Arc<AtomicBool>,
) -> Result<()> {
    proxy.set_read_timeout(Some(Duration::from_secs(5)))?;
    verify_proxy(&proxy)?;
    let (request, fds) = receive_request(&mut proxy)?;
    validate(&request, &token, &temp).map_err(|_| invalid())?;
    let profile = request
        .args
        .iter()
        .find_map(|a| a.strip_prefix("--user-data-dir="))
        .ok_or_else(invalid)?;
    if !Path::new(profile)
        .canonicalize()?
        .starts_with(temp.canonicalize()?)
    {
        return Err(invalid().into());
    }
    if stopping.load(Ordering::SeqCst) {
        return Err(invalid().into());
    }
    let (parent, child) = UnixStream::pair()?;
    let ctl = duplicate(child.as_raw_fd())?;
    let mut command = Command::new(env::current_exe()?);
    command
        .arg("--anchor")
        .arg(&request.kind)
        .args(&request.args)
        .env_clear()
        .envs(&request.env)
        .stdin(Stdio::null())
        .stdout(Stdio::from(duplicate(fds[0].as_raw_fd())?))
        .stderr(Stdio::from(duplicate(fds[1].as_raw_fd())?))
        .process_group(0);
    let (a, b, c) = (fds[2].as_raw_fd(), fds[3].as_raw_fd(), ctl.as_raw_fd());
    unsafe {
        command.pre_exec(move || {
            for (src, dst) in [(a, 3), (b, 4), (c, 5)] {
                if libc::dup2(src, dst) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let mut owned = OwnedGroup::new(command.spawn()?);
    let mut parent = parent;
    drop(child);
    drop(ctl);
    drop(fds);
    if stopping.load(Ordering::SeqCst) {
        return Ok(());
    }
    owned.state.grant().map_err(|_| invalid())?;
    parent.write_all(b"GO\n")?;
    proxy.write_all(b"ACK\n")?;
    proxy.set_read_timeout(None)?;
    let mut exit = 1;
    loop {
        if force.load(Ordering::SeqCst) {
            break;
        }
        if poll(proxy.as_raw_fd(), 0)? {
            let mut b = [0];
            let _ = proxy.read(&mut b);
            break;
        }
        if poll(parent.as_raw_fd(), 100)? {
            if let Ok(value) = line(&mut parent, 64) {
                exit = value
                    .strip_prefix("EXIT ")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1);
            }
            break;
        }
        if owned.exited()? {
            break;
        }
    }
    // Retained direct anchor prevents PID reuse throughout this one group signal/reap.
    owned.stop()?;
    let _ = writeln!(proxy, "EXIT {exit}");
    Ok(())
}
fn proxy(args: &[String]) -> Result<()> {
    let root = runtime()?;
    if env::var_os("SITE_FACTORY_RUNTIME_ROOT")
        .map(PathBuf::from)
        .map(|p| p.canonicalize())
        .transpose()?
        .as_ref()
        != Some(&root)
    {
        return Err(invalid().into());
    }
    let socket = env::var("SITE_FACTORY_GUARD_SOCKET")?;
    let token = env::var("SITE_FACTORY_GUARD_TOKEN")?;
    let kind = env::var("SITE_FACTORY_BROWSER_KIND")?;
    let mut selected = BTreeMap::new();
    for key in ["HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"] {
        if let Ok(value) = env::var(key) {
            selected.insert(key.into(), value);
        }
    }
    let request = BrowserRequest {
        token,
        kind,
        args: args.to_vec(),
        env: selected,
    };
    let temp = PathBuf::from(env::var("TMPDIR")?);
    validate(&request, &request.token, &temp).map_err(|_| invalid())?;
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    send_request(&stream, &request)?;
    unsafe {
        libc::close(3);
        libc::close(4);
    }
    if line(&mut stream, 32)? != "ACK" {
        return Err(invalid().into());
    }
    stream.set_read_timeout(None)?;
    let result = line(&mut stream, 64)?;
    std::process::exit(
        result
            .strip_prefix("EXIT ")
            .and_then(|v| v.parse::<i32>().ok())
            .filter(|n| *n >= 0 && *n <= 255)
            .unwrap_or(1),
    )
}
fn worker() -> Result<()> {
    let root = runtime()?;
    let data =
        PathBuf::from(env::var_os("SITE_FACTORY_DATA_ROOT").ok_or_else(invalid)?).canonicalize()?;
    let mut random = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
    let token = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let paths = WorkerPaths::create(&data)?;
    let listener = paths.bind()?;
    let stopping = Arc::new(AtomicBool::new(false));
    let force = Arc::new(AtomicBool::new(false));
    let stop_listener = stopping.clone();
    let force_listener = force.clone();
    let temp = paths.temp.clone();
    fs::create_dir_all(&temp)?;
    fs::set_permissions(&temp, fs::Permissions::from_mode(0o700))?;
    let socket_for_node = paths.socket.clone();
    let token_for_node = token.clone();
    let listener_thread = thread::spawn(move || {
        let mut work: Vec<thread::JoinHandle<()>> = Vec::new();
        while !stop_listener.load(Ordering::SeqCst) {
            let mut i = 0;
            while i < work.len() {
                if work[i].is_finished() {
                    let _ = work.swap_remove(i).join();
                } else {
                    i += 1;
                }
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    if work.len() >= 32 {
                        drop(stream);
                        continue;
                    }
                    let (token, temp, stop, force) = (
                        token.clone(),
                        temp.clone(),
                        stop_listener.clone(),
                        force_listener.clone(),
                    );
                    work.push(thread::spawn(move || {
                        let _ = browser_connection(stream, token, temp, stop, force);
                    }));
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20))
                }
                Err(_) => break,
            }
        }
        for thread in work {
            let _ = thread.join();
        }
    });
    let mut listener_owner = OwnerListener::new(stopping.clone(), force.clone(), listener_thread);
    let mut command = Command::new(root.join("node"));
    command
        .arg(root.join("apps/worker/src/stdio.js"))
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .env("SITE_FACTORY_RUNTIME_ROOT", &root)
        .env("SITE_FACTORY_GUARD_SOCKET", socket_for_node)
        .env("SITE_FACTORY_GUARD_TOKEN", token_for_node);
    let mut owned = OwnedGroup::new(command.spawn()?);
    owned.group = false;
    let mut input = owned.child.stdin.take().ok_or_else(invalid)?;
    owned.state.grant().map_err(|_| invalid())?;
    let mut buffer = [0u8; 65536];
    let mut reader = io::stdin();
    loop {
        if owned.exited()? {
            break;
        }
        if poll(0, 100)? {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            input.write_all(&buffer[..n])?;
        }
    }
    stopping.store(true, Ordering::SeqCst);
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !owned.exited()? {
        thread::sleep(Duration::from_millis(25));
    }
    force.store(true, Ordering::SeqCst);
    listener_owner.stop();
    owned.stop()?;
    paths.close()?;
    Ok(())
}
pub fn run() -> Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--worker") {
        if args.len() != 1 {
            return Err(invalid().into());
        }
        worker()
    } else if args.first().map(String::as_str) == Some("--anchor") {
        if args.len() < 2 {
            return Err(invalid().into());
        }
        anchor(&args[1], &args[2..])
    } else {
        proxy(&args)
    }
}
