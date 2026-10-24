// Session directory checks, safe deletion, and the session record.
//
// Deletion holds a handle on every directory from the root down, opened
// without FILE_SHARE_DELETE, so no ancestor can be renamed or replaced while
// the tree is removed. Every entry is opened with FILE_FLAG_OPEN_REPARSE_POINT
// and deleted through that handle: a junction, symlink, or other reparse
// point is removed as a link and never followed (spec section 4.5).
//
// Design adapted from @iiwate/pi-silent-gui 0.2.0 (MIT, Copyright (c) 2026
// IIwate; see ../../THIRD_PARTY_NOTICES.md): deletion holds directory handles
// level by level and refuses to traverse reparse points.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace PiGuiHelper.Win
{
    internal static class WinFiles
    {
        const int MaxDepth = 128;
        const int MaxEntries = 1000000;

        static readonly string[] BroadSids = new string[] {
            "S-1-1-0",      // Everyone
            "S-1-5-11",     // Authenticated Users
            "S-1-5-32-545", // Users
            "S-1-5-4",      // INTERACTIVE
            "S-1-5-7",      // ANONYMOUS LOGON
        };

        static IntPtr OpenNoFollow(string path, uint access, uint share)
        {
            return Native.CreateFileNoSecurity(path, access, share, IntPtr.Zero, Native.OPEN_EXISTING,
                Native.FILE_FLAG_BACKUP_SEMANTICS | Native.FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
        }

        static string FinalPath(IntPtr handle)
        {
            var b = new StringBuilder(32768);
            int n = Native.GetFinalPathNameByHandleW(handle, b, b.Capacity, 0);
            if (n <= 0 || n >= b.Capacity) return null;
            string s = b.ToString(0, n);
            if (s.StartsWith("\\\\?\\UNC\\", StringComparison.Ordinal)) return "\\\\" + s.Substring(8);
            if (s.StartsWith("\\\\?\\", StringComparison.Ordinal)) return s.Substring(4);
            return s;
        }

        /// <summary>The path with 8.3 short names expanded (junctions are not resolved), or the path itself.</summary>
        static string LongPath(string path)
        {
            var b = new StringBuilder(32768);
            int n = Native.GetLongPathNameW(path, b, b.Capacity);
            return n > 0 && n < b.Capacity ? b.ToString(0, n) : path;
        }

        /// <summary>
        /// The runtime dir must be a real directory (not a reparse point), reached without any
        /// junction or symlink on the way (its final path equals the given path), owned by the
        /// helper's user, Administrators, or SYSTEM, and not writable by broad groups.
        /// </summary>
        public static void CheckPrivateDir(string path, string what)
        {
            IntPtr h = OpenNoFollow(path, Native.FILE_READ_ATTRIBUTES, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE | Native.FILE_SHARE_DELETE);
            if (h == Native.INVALID_HANDLE_VALUE) throw new InvalidOperationException(what + " " + path + " cannot be opened: " + Native.Error("CreateFile"));
            try
            {
                BY_HANDLE_FILE_INFORMATION info;
                if (!Native.GetFileInformationByHandle(h, out info)) throw new InvalidOperationException(Native.Error("GetFileInformationByHandle"));
                if ((info.FileAttributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException(what + " " + path + " is a junction, symlink, or other reparse point");
                if ((info.FileAttributes & Native.FILE_ATTRIBUTE_DIRECTORY) == 0) throw new InvalidOperationException(what + " " + path + " is not a directory");
                string final = FinalPath(h);
                string expected = LongPath(path);
                if (final == null || !string.Equals(final.TrimEnd('\\'), expected.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException(what + " " + path + " resolves to " + (final ?? "?") + "; a junction or symlink is on the way");
            }
            finally
            {
                Native.CloseHandle(h);
            }
            DirectorySecurity security = Directory.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access);
            var owner = (SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier));
            SecurityIdentifier user = WinSecurity.CurrentUser();
            var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            if (owner != user && owner != admins && owner != system)
                throw new InvalidOperationException(what + " " + path + " is owned by " + owner.Value + ", not by the helper's user");
            const FileSystemRights Write = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.Delete |
                FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership |
                FileSystemRights.WriteAttributes | FileSystemRights.WriteExtendedAttributes;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow || (rule.FileSystemRights & Write) == 0) continue;
                if (Array.IndexOf(BroadSids, rule.IdentityReference.Value) >= 0)
                    throw new InvalidOperationException(what + " " + path + " is writable by " + rule.IdentityReference.Value + "; it must be private to the user");
            }
        }

        /// <summary>Creates a new private subdirectory (it must not exist yet) and checks it.</summary>
        public static string CreateSubdir(string parent, string name)
        {
            string path = WinPath.Combine(parent, name);
            if (Directory.Exists(path) || File.Exists(path)) throw new InvalidOperationException(path + " already exists; the runtime dir must start empty");
            Directory.CreateDirectory(path);
            CheckPrivateDir(path, "session dir");
            return path;
        }

        static bool DeleteByHandle(IntPtr h)
        {
            byte delete = 1;
            return Native.SetFileInformationByHandle(h, Native.FileDispositionInfo, ref delete, 1);
        }

        /// <summary>Deletes a directory tree without following reparse points. Returns the problems (empty on success).</summary>
        public static List<string> DeleteTree(string root)
        {
            var problems = new List<string>();
            if (!Directory.Exists(root) && !File.Exists(root)) return problems;
            int entries = 0;
            DeleteDirectory(root, 0, ref entries, problems);
            return problems;
        }

        static void DeleteDirectory(string path, int depth, ref int entries, List<string> problems)
        {
            IntPtr dir = OpenNoFollow(path, Native.DELETE | Native.FILE_LIST_DIRECTORY | Native.FILE_READ_ATTRIBUTES | Native.SYNCHRONIZE,
                Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE);
            if (dir == Native.INVALID_HANDLE_VALUE)
            {
                problems.Add(path + ": " + Native.Error("open"));
                return;
            }
            try
            {
                BY_HANDLE_FILE_INFORMATION info;
                if (!Native.GetFileInformationByHandle(dir, out info))
                {
                    problems.Add(path + ": " + Native.Error("GetFileInformationByHandle"));
                    return;
                }
                if ((info.FileAttributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || (info.FileAttributes & Native.FILE_ATTRIBUTE_DIRECTORY) == 0)
                {
                    // Not a plain directory (anymore): remove the entry itself, never what it points to.
                    if (!DeleteByHandle(dir)) problems.Add(path + ": " + Native.Error("delete link"));
                    return;
                }
                if (depth >= MaxDepth)
                {
                    problems.Add(path + ": nested deeper than " + MaxDepth + " levels");
                    return;
                }
                WIN32_FIND_DATA data;
                IntPtr find = Native.FindFirstFileW(WinPath.Combine(path, "*"), out data);
                if (find != Native.INVALID_HANDLE_VALUE)
                {
                    try
                    {
                        do
                        {
                            string name = data.cFileName;
                            if (name == "." || name == "..") continue;
                            if (++entries > MaxEntries)
                            {
                                problems.Add(path + ": more than " + MaxEntries + " entries");
                                return;
                            }
                            string child = WinPath.Combine(path, name);
                            bool isDir = (data.dwFileAttributes & Native.FILE_ATTRIBUTE_DIRECTORY) != 0;
                            bool isLink = (data.dwFileAttributes & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0;
                            if (isDir && !isLink) DeleteDirectory(child, depth + 1, ref entries, problems);
                            else DeleteEntry(child, problems);
                        }
                        while (Native.FindNextFileW(find, out data));
                    }
                    finally
                    {
                        Native.FindClose(find);
                    }
                }
                if (!DeleteByHandle(dir)) problems.Add(path + ": " + Native.Error("delete directory"));
            }
            finally
            {
                Native.CloseHandle(dir);
            }
        }

        static void DeleteEntry(string path, List<string> problems)
        {
            IntPtr h = OpenNoFollow(path, Native.DELETE | Native.FILE_READ_ATTRIBUTES | Native.FILE_WRITE_ATTRIBUTES, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE | Native.FILE_SHARE_DELETE);
            if (h == Native.INVALID_HANDLE_VALUE)
            {
                problems.Add(path + ": " + Native.Error("open"));
                return;
            }
            try
            {
                if (DeleteByHandle(h)) return;
                // Read-only files refuse deletion: clear the attribute on this same object, then retry.
                BY_HANDLE_FILE_INFORMATION info;
                if (Native.GetFileInformationByHandle(h, out info) && (info.FileAttributes & Native.FILE_ATTRIBUTE_READONLY) != 0)
                {
                    // FILE_BASIC_INFO: four times (0 = unchanged), then the attributes at offset 32.
                    var basic = new byte[40];
                    uint attributes = info.FileAttributes & ~Native.FILE_ATTRIBUTE_READONLY;
                    BitConverter.GetBytes(attributes == 0 ? Native.FILE_ATTRIBUTE_NORMAL : attributes).CopyTo(basic, 32);
                    if (Native.SetFileInformationByHandle(h, Native.FileBasicInfo, ref basic[0], basic.Length) && DeleteByHandle(h)) return;
                }
                problems.Add(path + ": " + Native.Error("delete"));
            }
            finally
            {
                Native.CloseHandle(h);
            }
        }

        /// <summary>Writes text to path atomically (temp file + replace).</summary>
        public static void WriteAtomic(string path, string text)
        {
            string temp = path + ".tmp";
            File.WriteAllText(temp, text, new UTF8Encoding(false));
            if (!Native.MoveFileExW(temp, path, Native.MOVEFILE_REPLACE_EXISTING | Native.MOVEFILE_WRITE_THROUGH))
                throw new IOException(Native.Error("MoveFileEx(" + path + ")"));
        }
    }
}
