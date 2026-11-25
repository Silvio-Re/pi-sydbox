#!/usr/bin/env python3
"""Verify a minisign signature with the standard library plus `cryptography`.

The release signature published next to the engine tarball is minisign, not
OpenPGP, so `gpg --verify` reports "no valid OpenPGP data" no matter which key is
imported. This script implements the wire format so verification needs no
`minisign` binary — the imports are the standard library plus `cryptography`
(ed25519), the same interpreter that runs the machine-setup drivers.

    signature file   "untrusted comment: ..."  / b64(alg2 | keyid8 | sig64)
                     "trusted comment: ..."    / b64(global_sig64)
    public key file  "untrusted comment: ..."  / b64(alg2 | keyid8 | pub32)

    alg "Ed"  ed25519 over the message itself
    alg "ED"  ed25519 over BLAKE2b-512(message), the prehashed variant
    global    ed25519 over (sig_blob || trusted_comment_text)
"""

import base64
import binascii
import hashlib
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

USAGE = "usage: python3 minisign_verify.py <pubkey> <signature> <file>"


class MinisignInputError(Exception):
    """Raised when a file cannot be read or does not hold a minisign payload."""


def read_lines(path: str) -> list[bytes]:
    try:
        with open(path, "rb") as handle:
            return handle.readlines()
    except OSError as err:
        raise MinisignInputError(f"cannot read {path}: {err}") from err


def read_minisign(path: str) -> list[bytes]:
    """Return the base64 payloads of a minisign file, comment lines removed."""
    payloads: list[bytes] = []
    for raw in read_lines(path):
        line = raw.rstrip(b"\r\n")
        if not line or line.startswith(b"untrusted comment:") or line.startswith(b"trusted comment:"):
            continue
        try:
            payloads.append(base64.b64decode(line))
        except (binascii.Error, ValueError) as err:
            raise MinisignInputError(f"{path}: payload is not base64: {err}") from err
    return payloads


def trusted_comment(path: str) -> bytes:
    prefix = b"trusted comment: "
    for raw in read_lines(path):
        line = raw.rstrip(b"\r\n")
        if line.startswith(prefix):
            return line[len(prefix) :]
    return b""


def read_file(path: str) -> bytes:
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except OSError as err:
        raise MinisignInputError(f"cannot read {path}: {err}") from err


def verify(pubkey_path: str, sig_path: str, file_path: str) -> int:
    keys = read_minisign(pubkey_path)
    sigs = read_minisign(sig_path)
    if not keys or len(keys[0]) != 42:
        print(f"public key: expected 42 decoded bytes, got {[len(k) for k in keys]}")
        return 2
    if not sigs or len(sigs[0]) != 74:
        print(f"signature: expected 74 decoded bytes, got {[len(s) for s in sigs]}")
        return 2

    key_alg, key_id, key_raw = keys[0][:2], keys[0][2:10], keys[0][10:]
    sig_alg, sig_id, sig_raw = sigs[0][:2], sigs[0][2:10], sigs[0][10:]
    print(f"key algorithm={key_alg.decode(errors='replace')} keyid={key_id.hex()}")
    print(f"sig algorithm={sig_alg.decode(errors='replace')} keyid={sig_id.hex()}")
    if key_id != sig_id:
        print("key id mismatch: the signature was not made by this key")
        return 1

    message = read_file(file_path)
    print(f"file={file_path} bytes={len(message)}")

    if sig_alg == b"ED":
        signed = hashlib.blake2b(message, digest_size=64).digest()
        print("signed input=BLAKE2b-512(file), prehashed variant")
    elif sig_alg == b"Ed":
        signed = message
        print("signed input=file, pure variant")
    else:
        print(f"unknown signature algorithm: {sig_alg!r}")
        return 2

    key = Ed25519PublicKey.from_public_bytes(key_raw)
    try:
        key.verify(sig_raw, signed)
    except InvalidSignature:
        print("signature: INVALID")
        return 1
    print("signature: valid")

    if len(sigs) >= 2 and len(sigs[1]) == 64:
        comment = trusted_comment(sig_path)
        try:
            key.verify(sigs[1], sigs[0] + comment)
        except InvalidSignature:
            print("trusted comment signature: INVALID")
            return 1
        print(f"trusted comment: {comment.decode(errors='replace')}")
        print("trusted comment signature: valid")
    else:
        print("trusted comment present but not signed; nothing to check there")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(USAGE, file=sys.stderr)
        return 2
    try:
        return verify(argv[1], argv[2], argv[3])
    except MinisignInputError as err:
        print(err, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
