mod proxy;

use rustex1_devserver::{args_to_config, Config, Server};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = std::env::current_dir().expect("current dir");
    let (config, rebuild) = args_to_config(&args, Config::discover(&root));

    let mut server = Server::new(config)
        .raw("/api/", proxy::handle_api)
        .raw("/ajcs/", proxy::handle_ajcs);
    if rebuild {
        server = server.rebuild_on_start();
    }
    server.run();
}
