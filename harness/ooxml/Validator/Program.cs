// Validates PPTX files against the Open XML schema (Office 2021). One JSON line per file on stdout:
// {"file": <basename>, "errors": [{"id", "part", "path", "description"}]}.
// Exit 0 whatever the errors are; harness.ooxml.validate decides the exit code and the privacy filtering.
//
// The package is opened through a read-only stream, so validating never changes the file (ruling M3-R61). When a
// relationship's target is one System.Uri cannot read (a hyperlink of about 65,520 characters or more), the SDK
// replaces it with a "rewritten://" placeholder and validates the rest; opened from the path, it also saved that
// placeholder into the file. Every such relationship is reported as the error Deckback.MalformedRelationship, so a
// target no .NET reader can read never passes as 0 errors. Its path is the relationship id; its target is not printed.
using System.Text.Json;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Validation;

var utf8 = new System.Text.UTF8Encoding(false);
using var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
var validator = new OpenXmlValidator(FileFormatVersions.Office2021);
const string Rewritten = "rewritten://";

foreach (var path in args)
{
    var errors = new List<Dictionary<string, string>>();
    try
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var doc = PresentationDocument.Open(stream, false);
        foreach (var e in validator.Validate(doc))
        {
            errors.Add(new()
            {
                ["id"] = e.Id ?? "",
                ["part"] = e.Part?.Uri.ToString() ?? "",
                ["path"] = e.Path?.XPath ?? "",
                ["description"] = e.Description ?? "",
            });
        }
        var containers = new List<(string Part, OpenXmlPartContainer Container)> { ("/", doc) };
        foreach (var part in doc.GetAllParts()) containers.Add((part.Uri.ToString(), part));
        foreach (var (part, container) in containers)
        {
            var targets = container.HyperlinkRelationships.Select(r => (r.Id, r.Uri))
                .Concat(container.ExternalRelationships.Select(r => (r.Id, r.Uri)));
            foreach (var (id, uri) in targets)
            {
                if (!uri.OriginalString.StartsWith(Rewritten, StringComparison.Ordinal)) continue;
                errors.Add(new()
                {
                    ["id"] = "Deckback.MalformedRelationship",
                    ["part"] = part,
                    ["path"] = id,
                    ["description"] = "A relationship target that System.Uri cannot read; the Open XML SDK replaced it.",
                });
            }
        }
    }
    catch (Exception ex)
    {
        // Any failure on one file is reported for that file only; the other files still validate. The exception text can quote file content, so keep only its type.
        errors.Add(new() { ["id"] = "Package.Unreadable", ["part"] = "", ["path"] = "", ["description"] = ex.GetType().Name });
    }
    stdout.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["file"] = Path.GetFileName(path),
        ["errors"] = errors,
    }, new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
}
return 0;
