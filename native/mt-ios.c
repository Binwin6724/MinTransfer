/*
 * mt-ios: a tiny batch client for two iPhone services MinTransfer needs on every platform:
 *  - AFC, the media area Apple lets computers browse (camera roll, Downloads, Books, Recordings…)
 *  - installation_proxy, to list and remove apps.
 * Built against libimobiledevice (LGPL-2.1); works with 1.3 and 1.4, so the same tool ships on
 * macOS and Windows (whose libimobiledevice build has no afcclient).
 *
 *   mt-ios -u UDID            reads commands from stdin, one per line, fields separated by TAB:
 *     ls    <dir>              E <d|f|l> <size> <mtime-seconds> <name>   … then OK
 *     walk  <dir>              E <d|f|l> <size> <mtime-seconds> <full path> (recursive) … OK
 *     get   <remote> <local>   OK <bytes>
 *     put   <local> <remote>   OK <bytes>
 *     rm    <remote>           OK            (files, or empty folders)
 *     mkdir <remote>           OK
 *     apps                     A <bundle id> <name> <version> <app bytes> <data bytes>  … then OK
 *     uninstall <bundle id>    OK
 *   Any failing command prints "ERR <message>" and the next command runs.
 *   If the phone can't be reached the tool prints "FATAL <message>" and exits with 1.
 *
 * MIT licensed, part of MinTransfer.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <libimobiledevice/libimobiledevice.h>
#include <libimobiledevice/afc.h>
#include <libimobiledevice/installation_proxy.h>
#include <plist/plist.h>

#ifdef _WIN32
#include <windows.h>
#include <fcntl.h>
#include <io.h>
static FILE *ufopen(const char *path, const char *mode) {
	wchar_t wpath[4096], wmode[8];
	if (!MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, 4096)) return NULL;
	if (!MultiByteToWideChar(CP_UTF8, 0, mode, -1, wmode, 8)) return NULL;
	return _wfopen(wpath, wmode);
}
#else
#define ufopen fopen
#endif

static afc_client_t afc = NULL;
static idevice_t dev = NULL;
static instproxy_client_t ip = NULL;

static void out(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
#include <stdarg.h>
static void out(const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	vprintf(fmt, ap);
	va_end(ap);
	fflush(stdout);
}

static int stat_path(const char *path, char *type, uint64_t *size, uint64_t *mtime) {
	char **info = NULL;
	if (afc_get_file_info(afc, path, &info) != AFC_E_SUCCESS || !info) return 0;
	*type = 'f';
	*size = 0;
	*mtime = 0;
	for (int i = 0; info[i] && info[i + 1]; i += 2) {
		if (!strcmp(info[i], "st_size")) *size = strtoull(info[i + 1], NULL, 10);
		else if (!strcmp(info[i], "st_mtime")) *mtime = strtoull(info[i + 1], NULL, 10) / 1000000000ULL;
		else if (!strcmp(info[i], "st_ifmt")) *type = !strcmp(info[i + 1], "S_IFDIR") ? 'd' : !strcmp(info[i + 1], "S_IFLNK") ? 'l' : 'f';
	}
	afc_dictionary_free(info);
	return 1;
}

static void join(char *dst, size_t n, const char *dir, const char *name) {
	if (!strcmp(dir, "/")) snprintf(dst, n, "/%s", name);
	else snprintf(dst, n, "%s/%s", dir, name);
}

static int list_dir(const char *dir, int recursive, int depth) {
	char **entries = NULL;
	afc_error_t err = afc_read_directory(afc, dir, &entries);
	if (err != AFC_E_SUCCESS) {
		if (depth == 0) out("ERR cannot list %s (%d)\n", dir, err);
		return 0;
	}
	for (int i = 0; entries && entries[i]; i++) {
		if (!strcmp(entries[i], ".") || !strcmp(entries[i], "..")) continue;
		char full[4096];
		join(full, sizeof(full), dir, entries[i]);
		char type;
		uint64_t size, mtime;
		if (!stat_path(full, &type, &size, &mtime)) continue;
		out("E\t%c\t%llu\t%llu\t%s\n", type, (unsigned long long)size, (unsigned long long)mtime, recursive ? full : entries[i]);
		if (recursive && type == 'd' && depth < 32) list_dir(full, 1, depth + 1);
	}
	afc_dictionary_free(entries);
	return 1;
}

static void cmd_get(const char *remote, const char *local) {
	uint64_t fh = 0;
	if (afc_file_open(afc, remote, AFC_FOPEN_RDONLY, &fh) != AFC_E_SUCCESS) {
		out("ERR cannot open %s\n", remote);
		return;
	}
	FILE *f = ufopen(local, "wb");
	if (!f) {
		afc_file_close(afc, fh);
		out("ERR cannot write %s\n", local);
		return;
	}
	static char buf[1 << 20];
	uint64_t total = 0;
	int ok = 1;
	for (;;) {
		uint32_t got = 0;
		if (afc_file_read(afc, fh, buf, sizeof(buf), &got) != AFC_E_SUCCESS) {
			ok = 0;
			break;
		}
		if (got == 0) break;
		if (fwrite(buf, 1, got, f) != got) {
			ok = 0;
			break;
		}
		total += got;
	}
	fclose(f);
	afc_file_close(afc, fh);
	if (ok) out("OK\t%llu\n", (unsigned long long)total);
	else out("ERR read failed for %s\n", remote);
}

static void cmd_put(const char *local, const char *remote) {
	FILE *f = ufopen(local, "rb");
	if (!f) {
		out("ERR cannot read %s\n", local);
		return;
	}
	uint64_t fh = 0;
	if (afc_file_open(afc, remote, AFC_FOPEN_WRONLY, &fh) != AFC_E_SUCCESS) {
		fclose(f);
		out("ERR cannot create %s\n", remote);
		return;
	}
	static char buf[1 << 20];
	uint64_t total = 0;
	int ok = 1;
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0) {
		uint32_t off = 0;
		while (off < n) {
			uint32_t wrote = 0;
			if (afc_file_write(afc, fh, buf + off, (uint32_t)(n - off), &wrote) != AFC_E_SUCCESS || wrote == 0) {
				ok = 0;
				break;
			}
			off += wrote;
		}
		if (!ok) break;
		total += n;
	}
	fclose(f);
	afc_file_close(afc, fh);
	if (ok) out("OK\t%llu\n", (unsigned long long)total);
	else out("ERR write failed for %s\n", remote);
}

static int start_instproxy(void) {
	if (ip) return 1;
	if (instproxy_client_start_service(dev, &ip, "mt-ios") != INSTPROXY_E_SUCCESS) {
		ip = NULL;
		out("ERR could not start the app service\n");
		return 0;
	}
	return 1;
}

static const char *dict_str(plist_t d, const char *key) {
	plist_t n = plist_dict_get_item(d, key);
	if (!n || plist_get_node_type(n) != PLIST_STRING) return "";
	const char *v = plist_get_string_ptr(n, NULL);
	return v ? v : "";
}

static unsigned long long dict_uint(plist_t d, const char *key) {
	plist_t n = plist_dict_get_item(d, key);
	uint64_t v = 0;
	if (n && plist_get_node_type(n) == PLIST_UINT) plist_get_uint_val(n, &v);
	return (unsigned long long)v;
}

static void clean(char *s) {
	for (; *s; s++) if (*s == '\t' || *s == '\n' || *s == '\r') *s = ' ';
}

static void cmd_apps(void) {
	if (!start_instproxy()) return;
	plist_t opts = instproxy_client_options_new();
	instproxy_client_options_add(opts, "ApplicationType", "User", NULL);
	instproxy_client_options_set_return_attributes(opts, "CFBundleIdentifier", "CFBundleDisplayName", "CFBundleName",
		"CFBundleShortVersionString", "StaticDiskUsage", "DynamicDiskUsage", NULL);
	plist_t apps = NULL;
	instproxy_error_t e = instproxy_browse(ip, opts, &apps);
	instproxy_client_options_free(opts);
	if (e != INSTPROXY_E_SUCCESS || !apps) {
		out("ERR could not list apps (%d)\n", e);
		return;
	}
	for (uint32_t i = 0; i < plist_array_get_size(apps); i++) {
		plist_t a = plist_array_get_item(apps, i);
		char id[512], name[512], ver[128];
		snprintf(id, sizeof(id), "%s", dict_str(a, "CFBundleIdentifier"));
		snprintf(name, sizeof(name), "%s", *dict_str(a, "CFBundleDisplayName") ? dict_str(a, "CFBundleDisplayName") : dict_str(a, "CFBundleName"));
		snprintf(ver, sizeof(ver), "%s", dict_str(a, "CFBundleShortVersionString"));
		clean(id);
		clean(name);
		clean(ver);
		out("A\t%s\t%s\t%s\t%llu\t%llu\n", id, name, ver, dict_uint(a, "StaticDiskUsage"), dict_uint(a, "DynamicDiskUsage"));
	}
	plist_free(apps);
	out("OK\n");
}

static void cmd_uninstall(const char *bundle) {
	if (!start_instproxy()) return;
	/* No status callback: the call returns when the phone has finished. */
	instproxy_error_t e = instproxy_uninstall(ip, bundle, NULL, NULL, NULL);
	if (e == INSTPROXY_E_SUCCESS) out("OK\n");
	else out("ERR could not remove %s (%d)\n", bundle, e);
}

int main(int argc, char **argv) {
#ifdef _WIN32
	_setmode(_fileno(stdout), _O_BINARY);
#endif
	const char *udid = NULL;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "-u") && i + 1 < argc) udid = argv[++i];
		else if (!strcmp(argv[i], "--version")) {
			out("mt-ios 1.0\n");
			return 0;
		}
	}
	if (idevice_new(&dev, udid) != IDEVICE_E_SUCCESS) {
		out("FATAL No device found%s%s\n", udid ? " with UDID " : "", udid ? udid : "");
		return 1;
	}
	afc_error_t aerr = afc_client_start_service(dev, &afc, "mt-ios");
	if (aerr != AFC_E_SUCCESS) {
		out("FATAL Could not start the file service (%d). Unlock the iPhone and tap Trust.\n", aerr);
		idevice_free(dev);
		return 1;
	}
	out("READY\n");

	char line[16384];
	while (fgets(line, sizeof(line), stdin)) {
		size_t len = strlen(line);
		while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
		if (!len) continue;
		char *fields[3] = {0};
		int nf = 0;
		char *p = line;
		fields[nf++] = p;
		while (nf < 3 && (p = strchr(p, '\t'))) {
			*p++ = 0;
			fields[nf++] = p;
		}
		const char *cmd = fields[0];
		if (!strcmp(cmd, "ls") && nf >= 2) {
			if (list_dir(fields[1], 0, 0)) out("OK\n");
		} else if (!strcmp(cmd, "walk") && nf >= 2) {
			if (list_dir(fields[1], 1, 0)) out("OK\n");
		} else if (!strcmp(cmd, "get") && nf == 3) {
			cmd_get(fields[1], fields[2]);
		} else if (!strcmp(cmd, "put") && nf == 3) {
			cmd_put(fields[1], fields[2]);
		} else if (!strcmp(cmd, "rm") && nf >= 2) {
			afc_error_t e = afc_remove_path(afc, fields[1]);
			if (e == AFC_E_SUCCESS) out("OK\n");
			else out("ERR cannot delete %s (%d)\n", fields[1], e);
		} else if (!strcmp(cmd, "mkdir") && nf >= 2) {
			afc_error_t e = afc_make_directory(afc, fields[1]);
			if (e == AFC_E_SUCCESS) out("OK\n");
			else out("ERR cannot create folder %s (%d)\n", fields[1], e);
		} else if (!strcmp(cmd, "apps")) {
			cmd_apps();
		} else if (!strcmp(cmd, "uninstall") && nf >= 2) {
			cmd_uninstall(fields[1]);
		} else {
			out("ERR unknown command\n");
		}
	}
	if (ip) instproxy_client_free(ip);
	afc_client_free(afc);
	idevice_free(dev);
	return 0;
}
