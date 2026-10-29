using System.Runtime.InteropServices;

namespace AIQuotaMonitor.Security;

public static class WindowsCredentialStore
{
    private const int GenericCredential = 1;
    private const int LocalMachinePersistence = 2;
    private const string Prefix = "AIQuotaMonitor:";

    public static void Save(string providerId, string secret)
    {
        var bytes = System.Text.Encoding.Unicode.GetBytes(secret);
        var pointer = Marshal.AllocHGlobal(bytes.Length + sizeof(char));
        try
        {
            Marshal.Copy(bytes, 0, pointer, bytes.Length);
            Marshal.WriteInt16(pointer, bytes.Length, 0);
            var credential = new Credential
            {
                Type = GenericCredential,
                TargetName = Prefix + providerId,
                CredentialBlobSize = bytes.Length,
                CredentialBlob = pointer,
                Persist = LocalMachinePersistence,
                UserName = Environment.UserName
            };
            if (!CredWrite(ref credential, 0))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.ZeroFreeGlobalAllocUnicode(pointer);
        }
    }

    public static string? Read(string providerId)
    {
        if (!CredRead(Prefix + providerId, GenericCredential, 0, out var pointer))
        {
            var error = Marshal.GetLastWin32Error();
            if (error == 1168) return null;
            throw new System.ComponentModel.Win32Exception(error);
        }
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(pointer);
            return Marshal.PtrToStringUni(credential.CredentialBlob,
                credential.CredentialBlobSize / sizeof(char));
        }
        finally { CredFree(pointer); }
    }

    public static void Delete(string providerId)
    {
        if (!CredDelete(Prefix + providerId, GenericCredential, 0) && Marshal.GetLastWin32Error() != 1168)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string? Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias;
        public string UserName;
    }

    [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, int flags);
    [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
    [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, int type, int flags);
    [DllImport("Advapi32.dll")]
    private static extern void CredFree(IntPtr credential);
}
