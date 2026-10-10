#!/usr/bin/env python3
"""Local certificate authority + server certificate for the G1 UI server (HTTPS/WSS on 8443), no sudo needed.

    hospital-sim-ui/server/tls/make_cert.sh                      # CA (kept if it exists) + server cert for this host
    hospital-sim-ui/server/tls/make_cert.sh --names robot.local 192.168.1.50   # extra DNS names / IPs

Writes hospital-sim-ui/server/tls/out/: ca.key (keep private), ca.crt (DER, install on the iPads), ca.pem, server.key, server.crt
(PEM chain server + CA). The server cert covers localhost, the hostname, <hostname>.local and every LAN IPv4 address
of this machine. Re-run after the robot's IP changes; the CA stays, so the iPads keep trusting it. In a hospital the
certificate comes from the hospital's internal CA instead (docs/ui/02 L-4), pushed to the iPads by MDM.
"""
import argparse
import datetime
import ipaddress
import os
import socket
import subprocess

from cryptography import x509
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')


def lan_ips():
    ips = set()
    try:
        out = subprocess.run(['hostname', '-I'], capture_output=True, text=True, timeout=5).stdout
        ips.update(x for x in out.split() if ':' not in x)
    except Exception:  # noqa: BLE001
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    ips.add('127.0.0.1')
    return sorted(ips)


def key_new():
    return ec.generate_private_key(ec.SECP256R1(), default_backend())


def write_key(path, key):
    with open(path, 'wb') as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                  serialization.NoEncryption()))
    os.chmod(path, 0o600)


def load_key(path):
    with open(path, 'rb') as f:
        return serialization.load_pem_private_key(f.read(), None, default_backend())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--names', nargs='*', default=[], help='extra DNS names or IP addresses')
    ap.add_argument('--new-ca', action='store_true', help='make a new CA (all iPads must re-install it)')
    ap.add_argument('--days', type=int, default=397, help='server certificate lifetime (iOS max 398)')
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    now = datetime.datetime.utcnow() - datetime.timedelta(minutes=5)
    ca_key_p, ca_pem_p = os.path.join(OUT, 'ca.key'), os.path.join(OUT, 'ca.pem')
    if a.new_ca or not (os.path.isfile(ca_key_p) and os.path.isfile(ca_pem_p)):
        ca_key = key_new()
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f'G1 robot local CA ({socket.gethostname()})'),
                          x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Hospital_G1 (development)')])
        ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(ca_key.public_key())
              .serial_number(x509.random_serial_number()).not_valid_before(now)
              .not_valid_after(now + datetime.timedelta(days=3650))
              .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
              .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True,
                                           content_commitment=False, key_encipherment=False, data_encipherment=False,
                                           key_agreement=False, encipher_only=False, decipher_only=False),
                             critical=True)
              .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
              .sign(ca_key, hashes.SHA256(), default_backend()))
        write_key(ca_key_p, ca_key)
        with open(ca_pem_p, 'wb') as f:
            f.write(ca.public_bytes(serialization.Encoding.PEM))
        print('new CA:', ca_pem_p)
    ca_key = load_key(ca_key_p)
    with open(ca_pem_p, 'rb') as f:
        ca = x509.load_pem_x509_certificate(f.read(), default_backend())
    with open(os.path.join(OUT, 'ca.crt'), 'wb') as f:          # DER: what iOS installs as a profile
        f.write(ca.public_bytes(serialization.Encoding.DER))

    host = socket.gethostname()
    dns = {'localhost', host, f'{host}.local'}
    ips = set(lan_ips())
    for n in a.names:
        try:
            ipaddress.ip_address(n)
            ips.add(n)
        except ValueError:
            dns.add(n)
    san = [x509.DNSName(d) for d in sorted(dns)] + [x509.IPAddress(ipaddress.ip_address(i)) for i in sorted(ips)]
    key = key_new()
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f'{host}.local')]))
            .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=a.days))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=False, content_commitment=False,
                                         data_encipherment=False, key_agreement=True, key_cert_sign=False,
                                         crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256(), default_backend()))
    write_key(os.path.join(OUT, 'server.key'), key)
    with open(os.path.join(OUT, 'server.crt'), 'wb') as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM) + ca.public_bytes(serialization.Encoding.PEM))
    print('server certificate:', os.path.join(OUT, 'server.crt'))
    print('  names:', ', '.join(sorted(dns)), '| IPs:', ', '.join(sorted(ips)))
    print(f'  valid until {cert.not_valid_after:%Y-%m-%d}')
    print('iPad: open http://<this host>:8080/tls/ca.crt is loopback-only; AirDrop / e-mail out/ca.crt, or open')
    print(f'  https://{sorted(ips)[-1]}:8443/tls/ca.crt once (accept the warning), then trust it (hospital-sim-ui/README.md).')


if __name__ == '__main__':
    main()
