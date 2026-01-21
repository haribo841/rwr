extends GeometryInstance3D

# 1. Use 'get_node_or_null' or check validity in ready to prevent crashing
@onready var timer: Timer = $Timer 

@export_dir var images_path: String
@export var image_extensions: Array[String] = ["png", "jpg"]

var found_images: Array[Texture2D] = []
var material: StandardMaterial3D
var images_idx: int = 0

func _ready() -> void:
	# --- FIX 1: Safety check for the Timer ---
	if not timer:
		printerr("CRITICAL: No 'Timer' child node found on ", name)
		set_process(false) # Stop processing if critical components miss
		return
		
	timer.timeout.connect(_on_timer_timeout)

	# Use 'make_dir_recursive' or just ensure path exists before opening
	var dir = DirAccess.open(images_path)
	
	# Check if directory opened successfully
	if dir:
		dir.list_dir_begin()
		var file_name = dir.get_next()
		while file_name != "":
			if not dir.current_is_dir():
				if file_name.get_extension() in image_extensions:
					# 'path_join' is cleaner than string concatenation
					var full_path = images_path.path_join(file_name)
					var image = load(full_path) as Texture2D
					if image:
						found_images.append(image)
			file_name = dir.get_next()
		dir.list_dir_end()
	else:
		printerr("Could not open path: '%s'" % images_path)

	# --- FIX 2: Handle material setup ---
	if material_override is StandardMaterial3D:
		material = material_override
	else:
		material = StandardMaterial3D.new()
		material_override = material

func _on_timer_timeout() -> void:
	# --- FIX 3: Prevent Division by Zero ---
	# If no images were found, .size() is 0. Modulo (%) 0 crashes the game.
	if found_images.is_empty():
		return
		
	images_idx += 1
	images_idx %= found_images.size()
	
	if material:
		material.albedo_texture = found_images[images_idx]
