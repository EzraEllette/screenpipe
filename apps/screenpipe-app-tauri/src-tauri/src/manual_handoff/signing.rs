// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::super::Identity;
use anyhow::{bail, Context, Result};
use core_foundation::{
    base::{CFType, CFTypeRef, TCFType},
    data::CFData,
    dictionary::{CFDictionary, CFDictionaryRef},
    string::{CFString, CFStringRef},
    url::CFURL,
};
use security_framework::os::macos::code_signing::{
    Flags, GuestAttributes, SecCode, SecRequirement, SecStaticCode,
};
use std::{
    mem::size_of,
    path::{Path, PathBuf},
};

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecCodeCopySigningInformation(
        code: CFTypeRef,
        flags: u32,
        info: *mut CFDictionaryRef,
    ) -> i32;
    fn SecCodeCopyDesignatedRequirement(
        code: CFTypeRef,
        flags: u32,
        requirement: *mut CFTypeRef,
    ) -> i32;
    fn SecRequirementCopyString(requirement: CFTypeRef, flags: u32, text: *mut CFStringRef) -> i32;
    static kSecCodeInfoIdentifier: CFStringRef;
    static kSecCodeInfoUnique: CFStringRef;
    static kSecCodeInfoPList: CFStringRef;
}
extern "C" {
    fn csops(pid: i32, operation: u32, address: *mut libc::c_void, size: usize) -> i32;
}

fn check(status: i32) -> Result<()> {
    if status != 0 {
        bail!("code signature status {status}");
    }
    Ok(())
}

fn information(code: CFTypeRef) -> Result<(String, String, String)> {
    unsafe {
        let mut raw = std::ptr::null();
        check(SecCodeCopySigningInformation(code, 1 << 1, &mut raw))?;
        let info = CFDictionary::<CFString, CFType>::wrap_under_create_rule(raw);
        let identifier = info
            .find(&CFString::wrap_under_get_rule(kSecCodeInfoIdentifier))
            .and_then(|v| v.downcast::<CFString>())
            .context("signature has no identifier")?
            .to_string();
        let hash = info
            .find(&CFString::wrap_under_get_rule(kSecCodeInfoUnique))
            .and_then(|v| v.downcast::<CFData>())
            .context("signature has no code hash")?;
        let plist = info
            .find(&CFString::wrap_under_get_rule(kSecCodeInfoPList))
            .and_then(|v| v.downcast::<CFDictionary>())
            .context("signature has no secured bundle metadata")?;
        let plist =
            CFDictionary::<CFString, CFType>::wrap_under_get_rule(plist.as_concrete_TypeRef());
        let version = plist
            .find(&CFString::new("CFBundleShortVersionString"))
            .and_then(|v| v.downcast::<CFString>())
            .context("bundle has no version")?
            .to_string();
        Ok((identifier, hex(hash.bytes()), version))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn process_stamp(pid: i32) -> Result<(u32, u64)> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let len = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size_of::<libc::proc_bsdinfo>() as i32,
        )
    };
    if len != size_of::<libc::proc_bsdinfo>() as i32 {
        bail!("process {pid} is unavailable");
    }
    Ok((
        info.pbi_uid,
        info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
    ))
}

pub(super) fn process_hash(pid: i32) -> Result<String> {
    let mut hash = [0u8; 20];
    if unsafe {
        csops(
            pid,
            5, /* CS_OPS_CDHASH */
            hash.as_mut_ptr().cast(),
            hash.len(),
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error()).context("read running code hash");
    }
    Ok(hex(&hash))
}

pub(super) fn is_same_process(identity: &Identity) -> bool {
    process_stamp(identity.pid).ok() == Some((identity.uid, identity.started))
        && process_hash(identity.pid).ok().as_deref() == Some(&identity.hash)
}

fn guest(pid: i32) -> Result<SecCode> {
    let mut attrs = GuestAttributes::new();
    attrs.set_pid(pid);
    Ok(SecCode::copy_guest_with_attribues(
        None,
        &attrs,
        Flags::NONE,
    )?)
}

pub(super) fn verify_process(pid: i32, requirement: &str) -> Result<()> {
    let requirement: SecRequirement = requirement.parse()?;
    guest(pid)?
        .check_validity(Flags::NONE, &requirement)
        .context("validate running app signature")?;
    Ok(())
}

pub(super) fn verify_audit_token(token: &[u32; 8], requirement: &str) -> Result<i32> {
    // audit_token_t fields: auid, euid, egid, ruid, rgid, pid, asid, pidversion.
    let pid = token[5] as i32;
    if token[1] != unsafe { libc::geteuid() } || pid <= 0 {
        bail!("different local user or invalid peer process");
    }
    let bytes: Vec<u8> = token.iter().flat_map(|word| word.to_ne_bytes()).collect();
    let data = CFData::from_buffer(&bytes);
    let mut attrs = GuestAttributes::new();
    attrs.set_audit_token(data.as_concrete_TypeRef());
    let code = SecCode::copy_guest_with_attribues(None, &attrs, Flags::NONE)
        .context("resolve authenticated peer process")?;
    let requirement: SecRequirement = requirement.parse()?;
    code.check_validity(Flags::NONE, &requirement)
        .context("validate authenticated peer signature")?;
    Ok(pid)
}

pub(super) fn own_requirement() -> Result<String> {
    let code = SecCode::for_self(Flags::NONE)?;
    unsafe {
        let mut raw = std::ptr::null();
        check(SecCodeCopyDesignatedRequirement(
            code.as_CFTypeRef(),
            0,
            &mut raw,
        ))?;
        let requirement = CFType::wrap_under_create_rule(raw);
        let mut text = std::ptr::null();
        check(SecRequirementCopyString(
            requirement.as_CFTypeRef(),
            0,
            &mut text,
        ))?;
        Ok(CFString::wrap_under_create_rule(text).to_string())
    }
}

pub(super) fn running(pid: i32, requirement: &str) -> Result<Identity> {
    let (uid, started) = process_stamp(pid)?;
    let code = guest(pid)?;
    let requirement: SecRequirement = requirement.parse()?;
    code.check_validity(Flags::NONE, &requirement)
        .context("validate running app signature")?;
    let (identifier, signed_hash, version) = information(code.as_CFTypeRef())?;
    let hash = process_hash(pid)?;
    // Do not assign an on-disk version/signature to an older running process.
    if hash != signed_hash {
        bail!("running signature differs from bundle metadata");
    }
    let executable = process_path(pid)?;
    Ok(Identity {
        pid,
        started,
        uid,
        identifier,
        version,
        hash,
        executable,
    })
}

pub(super) fn on_disk(executable: &Path, requirement: &str, owner: &Identity) -> Result<Identity> {
    let macos = executable.parent().context("missing executable parent")?;
    let contents = macos.parent().context("missing bundle Contents")?;
    if macos.file_name() != Some(std::ffi::OsStr::new("MacOS"))
        || contents.file_name() != Some(std::ffi::OsStr::new("Contents"))
    {
        bail!("replacement is not a bundle executable");
    }
    let bundle = contents.parent().context("missing application bundle")?;
    let url = CFURL::from_path(bundle, true).context("invalid executable path")?;
    let code = SecStaticCode::from_path(&url, Flags::NONE)?;
    let requirement: SecRequirement = requirement.parse()?;
    code.check_validity(
        Flags::STRICT_VALIDATE | Flags::CHECK_NESTED_CODE,
        &requirement,
    )?;
    let (identifier, hash, version) = information(code.as_CFTypeRef())?;
    Ok(Identity {
        identifier,
        version,
        hash,
        executable: executable.to_path_buf(),
        ..owner.clone()
    })
}

pub(super) fn process_path(pid: i32) -> Result<PathBuf> {
    let mut buf = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let len = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if len <= 0 {
        bail!("process executable is unavailable");
    }
    use std::os::unix::ffi::OsStrExt;
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..end])))
}

pub(super) fn candidates(executable_name: &std::ffi::OsStr) -> Result<Vec<i32>> {
    let mut pids = vec![0i32; 8192];
    let bytes = unsafe {
        libc::proc_listpids(
            4, /* PROC_UID_ONLY, sys/proc_info.h */
            libc::geteuid(),
            pids.as_mut_ptr().cast(),
            (pids.len() * size_of::<i32>()) as i32,
        )
    };
    if bytes <= 0 || bytes as usize >= pids.len() * size_of::<i32>() {
        bail!("could not enumerate app processes");
    }
    pids.truncate(bytes as usize / size_of::<i32>());
    Ok(pids
        .into_iter()
        .filter(|pid| *pid > 0 && *pid != std::process::id() as i32)
        .filter(|pid| {
            process_path(*pid)
                .ok()
                .and_then(|p| p.file_name().map(|n| n == executable_name))
                .unwrap_or(false)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_process_satisfies_its_designated_requirement() {
        let requirement = own_requirement().unwrap();
        verify_process(std::process::id() as i32, &requirement).unwrap();
        assert!(!process_hash(std::process::id() as i32).unwrap().is_empty());
    }
}
