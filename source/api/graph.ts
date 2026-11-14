import { processFiles } from "../utils/file-operations.js";

export async function sendProjectFiles(
    socketId: string,
    workspace: string, 
): Promise<{status: string, message: string, files_processed: number}> {
    const res = await fetch(`${process.env['BACKEND_URI']}/remote/repo/ingest`, {
        method: "POST", 
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(
            {
                project_name: workspace, 
                socket_id: socketId, 
                files: await processFiles(workspace), 
            }
        )
    });
    const result = await res.json() as {
        status?: string;
        message?: string;
        files_processed?: number;
    };
    if (!res.ok || result.status === "error") {
        throw new Error(result.message || `Repository ingestion failed (${res.status}).`);
    }
    return result as {status: string, message: string, files_processed: number};
}
